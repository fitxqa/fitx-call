package qa.fitx.call;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** True while the app is on screen — then the web app rings itself instead of a notification. */
    public static volatile boolean inForeground = false;
    private static volatile boolean pipAllowed = false;

    /** Video call in progress → leaving the app shrinks it to a floating window. */
    static void setPipAllowed(android.app.Activity a, boolean on) {
        pipAllowed = on;
        if (a == null || Build.VERSION.SDK_INT < 31) return;
        a.runOnUiThread(() -> {
            try {
                a.setPictureInPictureParams(new android.app.PictureInPictureParams.Builder()
                    .setAspectRatio(new android.util.Rational(9, 16)).setAutoEnterEnabled(on).setSeamlessResizeEnabled(true).build());
            } catch (Exception ignored) {}
        });
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (pipAllowed && Build.VERSION.SDK_INT >= 26 && Build.VERSION.SDK_INT < 31) {
            try {
                enterPictureInPictureMode(new android.app.PictureInPictureParams.Builder()
                    .setAspectRatio(new android.util.Rational(9, 16)).build());
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPip, android.content.res.Configuration cfg) {
        super.onPictureInPictureModeChanged(isInPip, cfg);
        com.getcapacitor.JSObject d = new com.getcapacitor.JSObject();
        d.put("active", isInPip);
        AudioRoutePlugin.emit("pip", d);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        super.onCreate(savedInstanceState);
        CallNotifications.ensureChannels(this);
        handleCallIntent(getIntent());
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 501);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleCallIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        inForeground = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        inForeground = false;
    }

    /** Opened from an incoming-call notification: show over the lock screen and stop the ringing notification. */
    private void handleCallIntent(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        boolean isCall = data != null && "fitxcall".equals(data.getScheme());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(isCall);
            setTurnScreenOn(isCall);
        } else if (isCall) {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            );
        }
        if (isCall) CallNotifications.cancelIncoming(this);
    }
}
