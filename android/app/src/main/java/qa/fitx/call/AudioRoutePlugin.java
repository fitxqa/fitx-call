package qa.fitx.call;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Native helpers: speaker/earpiece, screen-off at ear, background "ready for calls"
 * service, native ringing notifications, and battery / full-screen permission checks.
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private static AudioRoutePlugin instance;

    @Override
    public void load() { instance = this; }

    /** Send an event to the web app (if it is running). */
    static void emit(String event, JSObject data) {
        AudioRoutePlugin p = instance;
        if (p != null) p.notifyListeners(event, data);
    }

    private PowerManager.WakeLock proximity;

    // ---------- normal (SIM) phone call while on a FitX call → hold / resume ----------
    private Object modeListener;                       // AudioManager.OnModeChangedListener (API 31+)
    private android.telephony.PhoneStateListener phoneListener; // older Android
    private boolean phoneBusy = false;

    private void onPhoneBusy(boolean busy) {
        if (busy == phoneBusy) return;
        phoneBusy = busy;
        JSObject d = new JSObject();
        d.put("state", busy ? "begin" : "end");
        notifyListeners("interruption", d);
    }

    private void watchPhoneCalls(boolean on) {
        AudioManager am = am();
        if (Build.VERSION.SDK_INT >= 31) {
            if (on && modeListener == null && am != null) {
                AudioManager.OnModeChangedListener l = (mode) -> onPhoneBusy(
                    mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_RINGTONE || mode == AudioManager.MODE_CALL_SCREENING
                    || (Build.VERSION.SDK_INT >= 33 && mode == AudioManager.MODE_CALL_REDIRECT));
                try { am.addOnModeChangedListener(getContext().getMainExecutor(), l); modeListener = l; } catch (Exception ignored) {}
            } else if (!on && modeListener != null && am != null) {
                try { am.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeListener); } catch (Exception ignored) {}
                modeListener = null;
            }
        } else {
            getActivity().runOnUiThread(() -> {
                try {
                    android.telephony.TelephonyManager tm = (android.telephony.TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
                    if (tm == null) return;
                    if (on && phoneListener == null) {
                        phoneListener = new android.telephony.PhoneStateListener() {
                            @Override public void onCallStateChanged(int state, String number) {
                                onPhoneBusy(state != android.telephony.TelephonyManager.CALL_STATE_IDLE);
                            }
                        };
                        tm.listen(phoneListener, android.telephony.PhoneStateListener.LISTEN_CALL_STATE);
                    } else if (!on && phoneListener != null) {
                        tm.listen(phoneListener, android.telephony.PhoneStateListener.LISTEN_NONE);
                        phoneListener = null;
                    }
                } catch (Exception ignored) {}
            });
        }
        if (!on) phoneBusy = false;
    }

    /** Phone call finished: take the audio back for the FitX call. */
    @PluginMethod
    public void resumeAudio(PluginCall call) {
        boolean speaker = call.getBoolean("speaker", false);
        AudioManager am = am();
        if (am != null) am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        call.getData().put("on", speaker);
        setSpeaker(call);
    }

    private AudioManager am() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    // ---------- call audio ----------
    @PluginMethod
    public void startCall(PluginCall call) {
        boolean video = call.getBoolean("video", false);
        AudioManager am = am();
        if (am != null) am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        getActivity().runOnUiThread(() -> getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        if (!video) {
            try {
                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                if (pm != null && pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                    proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "fitxcall:proximity");
                    proximity.acquire(4 * 60 * 60 * 1000L);
                }
            } catch (Exception ignored) {}
        }
        watchPhoneCalls(true);
        CallService.callPeer = call.getString("name", "FitX Call");
        CallService.callVideo = video;
        CallService.callStartedAt = 0;
        CallService.start(getContext(), true);   // ongoing-call notification (timer + End call)
        call.resolve();
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        AudioManager am = am();
        if (am != null) {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= 31) {
                int want = on ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
                AudioDeviceInfo pick = null;
                for (AudioDeviceInfo dev : devices) {
                    int t = dev.getType();
                    if (!on && (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                        || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLE_HEADSET)) { pick = dev; break; }
                    if (t == want && pick == null) pick = dev;
                }
                if (pick != null) am.setCommunicationDevice(pick);
            } else {
                am.setSpeakerphoneOn(on);
            }
        }
        if (on && proximity != null && proximity.isHeld()) proximity.release();
        call.resolve();
    }

    @PluginMethod
    public void endCall(PluginCall call) {
        AudioManager am = am();
        if (am != null) {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice();
            else am.setSpeakerphoneOn(false);
            am.setMode(AudioManager.MODE_NORMAL);
        }
        if (proximity != null && proximity.isHeld()) proximity.release();
        proximity = null;
        getActivity().runOnUiThread(() -> getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        CallNotifications.cancelIncoming(getContext());
        watchPhoneCalls(false);
        CallService.callPeer = null; CallService.callStartedAt = 0;
        MainActivity.setPipAllowed(getActivity(), false);
        if (call.getBoolean("keepService", true)) CallService.start(getContext(), false);
        else CallService.stop(getContext());
        call.resolve();
    }

    // ---------- background service ----------
    @PluginMethod
    public void startService(PluginCall call) {
        CallNotifications.cancelClosed(getContext());
        CallService.start(getContext(), false);
        call.resolve();
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        CallService.stop(getContext());
        call.resolve();
    }

    // ---------- native background listener (works when the app is closed) ----------
    @PluginMethod
    public void nativeSignIn(PluginCall call) {
        String email = call.getString("email", ""), password = call.getString("password", ""), db = call.getString("db", "(default)");
        NativeWatcher.prefs(getContext()).edit().putString("db", db).apply();
        try {
            NativeWatcher.app(getContext());
            com.google.firebase.auth.FirebaseAuth.getInstance().signInWithEmailAndPassword(email, password)
                .addOnSuccessListener((r) -> { NativeWatcher.start(getContext()); CallService.start(getContext(), false); call.resolve(); })
                .addOnFailureListener((e) -> call.reject(e.getMessage() == null ? "failed" : e.getMessage()));
        } catch (Exception e) { call.reject(e.getMessage() == null ? "failed" : e.getMessage()); }
    }

    @PluginMethod
    public void nativeStatus(PluginCall call) {
        JSObject r = new JSObject();
        String uid = null;
        try { com.google.firebase.auth.FirebaseUser u = com.google.firebase.auth.FirebaseAuth.getInstance().getCurrentUser(); if (u != null) uid = u.getUid(); } catch (Exception ignored) {}
        r.put("signedIn", uid != null);
        r.put("uid", uid);
        call.resolve(r);
    }

    @PluginMethod
    public void nativeSignOut(PluginCall call) {
        NativeWatcher.stop();
        try { com.google.firebase.auth.FirebaseAuth.getInstance().signOut(); } catch (Exception ignored) {}
        call.resolve();
    }

    // ---------- ringing ----------
    @PluginMethod
    public void ringIncoming(PluginCall call) {
        String id = call.getString("callId", "");
        String from = call.getString("fromName", "FitX");
        String type = call.getString("callType", "audio");
        boolean shown = false;
        if (!MainActivity.inForeground) {
            CallNotifications.showIncoming(getContext(), id, from, type);
            shown = true;
        }
        JSObject r = new JSObject();
        r.put("shown", shown);
        call.resolve(r);
    }

    @PluginMethod
    public void cancelIncoming(PluginCall call) {
        CallNotifications.cancelIncoming(getContext());
        call.resolve();
    }

    @PluginMethod
    public void showMissed(PluginCall call) {
        if (!MainActivity.inForeground) {
            CallNotifications.showMissed(getContext(), call.getString("callId", "x"), call.getString("fromName", "FitX"), call.getString("callType", "audio"));
        }
        call.resolve();
    }

    @PluginMethod
    public void showMessage(PluginCall call) {
        if (!MainActivity.inForeground) {
            CallNotifications.showMessage(getContext(), call.getString("chatId", "x"), call.getString("fromName", "FitX"), call.getString("text", "New message"));
        }
        call.resolve();
    }

    @PluginMethod
    public void isForeground(PluginCall call) {
        JSObject r = new JSObject();
        r.put("value", MainActivity.inForeground);
        call.resolve(r);
    }

    // ---------- reliability checks ----------
    @PluginMethod
    public void checkReliability(PluginCall call) {
        JSObject r = new JSObject();
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        r.put("battery", pm == null || pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        boolean fsi = true;
        if (Build.VERSION.SDK_INT >= 34) {
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            fsi = nm == null || nm.canUseFullScreenIntent();
        }
        r.put("fullScreen", fsi);
        boolean notif = true;
        if (Build.VERSION.SDK_INT >= 24) {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            notif = nm == null || nm.areNotificationsEnabled();
        }
        r.put("notifications", notif);
        r.put("service", CallService.running);
        call.resolve(r);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            openAppSettings();
        }
        call.resolve();
    }

    @PluginMethod
    public void openFullScreenSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } else openAppSettings();
        } catch (Exception e) { openAppSettings(); }
        call.resolve();
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) { openAppSettings(); }
        call.resolve();
    }

    // ---------- in-call: notification timer + picture-in-picture ----------
    @PluginMethod
    public void callConnected(PluginCall call) {
        CallService.callStartedAt = call.getLong("startedAt", System.currentTimeMillis());
        CallService.start(getContext(), true);
        call.resolve();
    }

    @PluginMethod
    public void setPip(PluginCall call) {
        MainActivity.setPipAllowed(getActivity(), call.getBoolean("enabled", false));
        call.resolve();
    }

    // ---------- phone (SIM) dialer ----------
    @PluginMethod
    public void dialPhone(PluginCall call) {
        String num = call.getString("number", "");
        boolean direct = call.getBoolean("direct", false);
        boolean can = direct && androidx.core.content.ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.CALL_PHONE)
            == android.content.pm.PackageManager.PERMISSION_GRANTED;
        if (direct && !can) {
            androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[] { android.Manifest.permission.CALL_PHONE }, 502);
        }
        try {
            Intent i = new Intent(can ? Intent.ACTION_CALL : Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(num)));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            JSObject r = new JSObject();
            r.put("direct", can);
            call.resolve(r);
        } catch (Exception e) { call.reject("No phone app on this device"); }
    }

    // ---------- appearance ----------
    @PluginMethod
    public void setTextZoom(PluginCall call) {
        int pct = Math.max(80, Math.min(150, call.getInt("percent", 100)));
        getActivity().runOnUiThread(() -> {
            try { getBridge().getWebView().getSettings().setTextZoom(pct); } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @PluginMethod
    public void setSystemBars(PluginCall call) {
        String color = call.getString("color", "#0b0b0c");
        boolean light = call.getBoolean("light", false);
        getActivity().runOnUiThread(() -> {
            try {
                android.view.Window w = getActivity().getWindow();
                int c = android.graphics.Color.parseColor(color);
                w.setStatusBarColor(c);
                w.setNavigationBarColor(c);
                androidx.core.view.WindowInsetsControllerCompat ic = androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView());
                ic.setAppearanceLightStatusBars(light);
                ic.setAppearanceLightNavigationBars(light);
                getBridge().getWebView().setBackgroundColor(c);
            } catch (Exception ignored) {}
            call.resolve();
        });
    }

    // ---------- app preferences shared with the background service ----------
    @PluginMethod
    public void setPref(PluginCall call) {
        NativeWatcher.prefs(getContext()).edit().putBoolean(call.getString("key", "x"), call.getBoolean("value", true)).apply();
        call.resolve();
    }

    @PluginMethod
    public void getPrefs(PluginCall call) {
        JSObject r = new JSObject();
        r.put("msgNotif", NativeWatcher.prefs(getContext()).getBoolean("msgNotif", true));
        call.resolve(r);
    }

    /** Opens the brand-specific "Autostart" page (Xiaomi, Oppo, Vivo, Huawei, Honor...), else app settings. */
    @PluginMethod
    public void openAutostart(PluginCall call) {
        String[][] targets = {
            { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
            { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
            { "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity" },
            { "com.oplus.safecenter", "com.oplus.safecenter.permission.startup.StartupAppListActivity" },
            { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" },
            { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
            { "com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity" },
            { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
            { "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity" },
            { "com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
            { "com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity" },
            { "com.asus.mobilemanager", "com.asus.mobilemanager.MainActivity" },
        };
        boolean opened = false;
        for (String[] t : targets) {
            try {
                Intent i = new Intent().setComponent(new android.content.ComponentName(t[0], t[1])).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (i.resolveActivity(getContext().getPackageManager()) != null) { getContext().startActivity(i); opened = true; break; }
            } catch (Exception ignored) {}
        }
        if (!opened) openAppSettings();
        JSObject r = new JSObject();
        r.put("brandPage", opened);
        call.resolve(r);
    }

    private void openAppSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) {}
    }
}
