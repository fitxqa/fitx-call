package qa.fitx.call;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.firestore.DocumentChange;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.ListenerRegistration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Watches Firestore for incoming calls and new messages from native Android code, inside the
 * background service — so the phone still rings after the app screen is closed or swiped away.
 * (Free alternative to server push: no Cloud Functions / Blaze plan needed.)
 */
final class NativeWatcher {

    private static ListenerRegistration callReg, chatReg, confReg;
    private static final Map<String, String[]> confRinging = new HashMap<>();
    private static String watchingUid = null;
    private static final Map<String, Long> chatLast = new HashMap<>();
    private static final Map<String, String[]> ringing = new HashMap<>(); // callId -> {fromName, type}
    private static boolean firstChats = true;

    private NativeWatcher() {}

    static SharedPreferences prefs(Context ctx) { return ctx.getSharedPreferences("fitx_native", Context.MODE_PRIVATE); }

    static FirebaseApp app(Context ctx) {
        return FirebaseApp.getApps(ctx).isEmpty() ? FirebaseApp.initializeApp(ctx) : FirebaseApp.getInstance();
    }

    static FirebaseFirestore db(Context ctx) {
        String id = prefs(ctx).getString("db", "(default)");
        FirebaseApp app = app(ctx);
        return "(default)".equals(id) ? FirebaseFirestore.getInstance(app) : FirebaseFirestore.getInstance(app, id);
    }

    static boolean signedIn() {
        try { return FirebaseAuth.getInstance().getCurrentUser() != null; } catch (Exception e) { return false; }
    }

    static synchronized void start(Context ctx) {
        final Context app = ctx.getApplicationContext();
        FirebaseUser u;
        try { app(app); u = FirebaseAuth.getInstance().getCurrentUser(); } catch (Exception e) { return; }
        if (u == null) { stop(); return; }
        if (u.getUid().equals(watchingUid) && callReg != null) return;
        stop();
        watchingUid = u.getUid();
        final String uid = watchingUid;
        FirebaseFirestore fs;
        try { fs = db(app); } catch (Exception e) { watchingUid = null; return; }

        // ----- Incoming calls -----
        callReg = fs.collection("calls").whereEqualTo("to", uid).whereEqualTo("status", "ringing")
            .addSnapshotListener((snap, err) -> {
                if (snap == null) return;
                for (DocumentChange dc : snap.getDocumentChanges()) {
                    DocumentSnapshot d = dc.getDocument();
                    String id = d.getId();
                    String from = str(d.get("fromName"), "FitX");
                    String type = str(d.get("type"), "audio");
                    if (dc.getType() == DocumentChange.Type.ADDED) {
                        Long created = d.getLong("createdAtMs");
                        if (created != null && System.currentTimeMillis() - created > 60000) continue; // stale
                        ringing.put(id, new String[] { from, type });
                        if (!MainActivity.inForeground) CallNotifications.showIncoming(app, id, from, type);
                    } else if (dc.getType() == DocumentChange.Type.REMOVED) {
                        String[] r = ringing.remove(id);
                        CallNotifications.cancelIncoming(app);
                        if (r != null && !MainActivity.inForeground) {
                            // Removed from "ringing": answered on this phone, declined, or caller gave up.
                            d.getReference().get().addOnSuccessListener((full) -> {
                                String st = full != null ? str(full.get("status"), "") : "";
                                if ("missed".equals(st) || "cancelled".equals(st)) CallNotifications.showMissed(app, id, r[0], r[1]);
                            });
                        }
                    }
                }
            });

        // ----- Group-call invites -----
        confReg = fs.collection("confs").whereArrayContains("invited", uid)
            .addSnapshotListener((snap, err) -> {
                if (snap == null) return;
                for (DocumentChange dc : snap.getDocumentChanges()) {
                    DocumentSnapshot d = dc.getDocument();
                    String id = "conf:" + d.getId();
                    if (dc.getType() == DocumentChange.Type.ADDED) {
                        Long created = d.getLong("createdAtMs");
                        if (!"active".equals(str(d.get("status"), "")) || (created != null && System.currentTimeMillis() - created > 3L * 3600000)) continue;
                        String host = str(d.get("hostName"), "FitX") + " (group)";
                        String type = str(d.get("type"), "audio");
                        confRinging.put(id, new String[] { host, type });
                        if (!MainActivity.inForeground) CallNotifications.showIncoming(app, id, host, type);
                    } else if (dc.getType() == DocumentChange.Type.REMOVED) {
                        String[] r = confRinging.remove(id);
                        CallNotifications.cancelIncoming(app);
                        if (r != null && !MainActivity.inForeground) CallNotifications.showMissed(app, id, r[0], r[1]);
                    }
                }
            });

        // ----- New messages -----
        firstChats = true;
        chatLast.clear();
        chatReg = fs.collection("chats").whereArrayContains("members", uid)
            .addSnapshotListener((snap, err) -> {
                if (snap == null) return;
                for (DocumentSnapshot c : snap.getDocuments()) {
                    Long at = c.getLong("lastAt");
                    Long prev = chatLast.get(c.getId());
                    chatLast.put(c.getId(), at == null ? 0L : at);
                    if (firstChats || at == null) continue;
                    if (prev != null && at <= prev) continue;
                    String lastFrom = str(c.get("lastFrom"), "");
                    if (lastFrom.equals(uid) || MainActivity.inForeground) continue;
                    String name = "FitX";
                    Object names = c.get("names");
                    if (names instanceof Map) { Object n = ((Map<?, ?>) names).get(lastFrom); if (n != null) name = n.toString(); }
                    CallNotifications.showMessage(app, c.getId(), name, str(c.get("lastText"), "New message"));
                }
                firstChats = false;
            });
    }

    static synchronized void stop() {
        if (callReg != null) callReg.remove();
        if (chatReg != null) chatReg.remove();
        if (confReg != null) confReg.remove();
        callReg = null; chatReg = null; confReg = null; watchingUid = null;
        confRinging.clear();
        ringing.clear();
    }

    private static String str(Object o, String def) { return o == null ? def : o.toString(); }

    @SuppressWarnings("unused")
    private static boolean nonEmpty(List<?> l) { return l != null && !l.isEmpty(); }
}
