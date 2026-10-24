package qa.fitx.call;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Keeps FitX Call alive in the background so it can ring for incoming calls
 * (free alternative to server push). Shows a small permanent notification.
 */
public class CallService extends Service {

    static final String CH_SERVICE = "fitx_ready";
    static final int ID_SERVICE = 7000;
    static volatile boolean running = false;

    static void start(Context ctx, boolean inCall) {
        Intent i = new Intent(ctx, CallService.class).putExtra("inCall", inCall);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Exception ignored) {}
    }

    static void stop(Context ctx) {
        try { ctx.stopService(new Intent(ctx, CallService.class)); } catch (Exception ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        boolean inCall = intent != null && intent.getBooleanExtra("inCall", false);
        ensureChannel();
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 10, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CH_SERVICE)
            .setSmallIcon(android.R.drawable.sym_action_call)
            .setContentTitle(inCall ? "FitX Call — on a call" : "FitX Call")
            .setContentText(inCall ? "Tap to return to the call" : "Ready to receive calls")
            .setColor(0xFFFF6A13)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build();
        int type = 0;
        if (Build.VERSION.SDK_INT >= 34) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            if (inCall) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        try {
            ServiceCompat.startForeground(this, ID_SERVICE, n, type);
        } catch (Exception e) {
            // Microphone type can be refused if not started from the foreground — fall back.
            try { ServiceCompat.startForeground(this, ID_SERVICE, n, Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0); }
            catch (Exception ignored) { stopSelf(); return START_NOT_STICKY; }
        }
        running = true;
        return START_NOT_STICKY;
    }

    /** App swiped away from recents: the call engine is gone, so be honest about it. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        running = false;
        CallNotifications.showClosed(this);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CH_SERVICE) == null) {
            NotificationChannel ch = new NotificationChannel(CH_SERVICE, "Ready for calls", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps FitX Call running so calls can ring");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }
}
