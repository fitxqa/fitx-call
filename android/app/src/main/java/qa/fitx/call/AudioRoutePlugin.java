package qa.fitx.call;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/** Speaker / earpiece switching, keep-screen-on, and screen-off near the ear during voice calls. */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

    private PowerManager.WakeLock proximity;

    private AudioManager am() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

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
                    // Prefer a connected headset / Bluetooth when going to "earpiece"
                    if (!on && (t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                        || t == AudioDeviceInfo.TYPE_USB_HEADSET || t == AudioDeviceInfo.TYPE_BLE_HEADSET)) { pick = dev; break; }
                    if (t == want && pick == null) pick = dev;
                }
                if (pick != null) am.setCommunicationDevice(pick);
            } else {
                am.setSpeakerphoneOn(on);
            }
        }
        // Screen-off-at-ear only makes sense on earpiece
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
        call.resolve();
    }
}
