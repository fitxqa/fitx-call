package qa.fitx.call;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/** Receives call pushes even when the app is closed, and rings the phone. */
public class CallMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        String type = d.get("type");
        String callId = d.get("callId");
        String from = d.get("fromName") != null ? d.get("fromName") : "FitX";
        String callType = d.get("callType");

        if ("call".equals(type) && callId != null) {
            // App on screen: the app shows its own incoming-call screen.
            if (!MainActivity.inForeground) CallNotifications.showIncoming(this, callId, from, callType);
        } else if ("call_end".equals(type) && callId != null) {
            CallNotifications.cancelIncoming(this);
            String status = d.get("status");
            if (!MainActivity.inForeground && ("missed".equals(status) || "cancelled".equals(status))) {
                CallNotifications.showMissed(this, callId, from, callType);
            }
        }
        super.onMessageReceived(msg);
    }
}
