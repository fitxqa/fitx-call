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

    private PowerManager.WakeLock proximity;

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
        if (CallService.running) CallService.start(getContext(), true);
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
        if (CallService.running) CallService.start(getContext(), false);
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

    private void openAppSettings() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) {}
    }
}
