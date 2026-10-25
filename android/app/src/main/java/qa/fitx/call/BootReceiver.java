package qa.fitx.call;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Phone restarted or app updated: start listening for calls again (if signed in). */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        try {
            NativeWatcher.app(ctx);
            if (NativeWatcher.signedIn()) CallService.start(ctx, false);
        } catch (Exception ignored) {}
    }
}
