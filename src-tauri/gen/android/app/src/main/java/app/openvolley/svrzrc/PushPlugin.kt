package app.openvolley.svrzrc

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.unifiedpush.android.connector.UnifiedPush

@InvokeArg
class PushSubscribeArgs {
  lateinit var vapidPublicKey: String
}

/**
 * Phone notifications in the installed Android app (src-tauri/src/push.rs,
 * src/lib/push.ts). The app's web view has no service worker and no Push API,
 * so the subscription comes from here instead: UnifiedPush, with the same
 * server key and the same /api/push/subscribe row as the browser. Endpoints are
 * plain Web Push, so the API's web-push sender reaches them unchanged.
 *
 * Which push service: a UnifiedPush app the coach installed (Sunup, ntfy), or,
 * without one, Google's through Play services — UnifiedPush's embedded FCM
 * distributor (LGPL, no Firebase SDK), which registers with our VAPID key and
 * hands back an fcm.googleapis.com endpoint. A distributor app that never
 * answers (installed but never opened) gets 10 s, then the built-in one takes
 * over. Same design as Wiedisync's Android app (2026-11-02).
 *
 * Refusals carry a code the page acts on: denied, no-distributor,
 * distributor-silent (message = that app's name), error.
 */
@TauriPlugin(
  permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")],
)
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  /** `subscribe` calls waiting for the distributor's NEW_ENDPOINT. */
  private val pending = mutableListOf<Invoke>()
  private var pendingVapid: String? = null
  private val distributorSilent = Runnable { onDistributorSilent() }
  /** Nothing answered at all, not even the built-in distributor: say so rather
   *  than leave the coach's switch spinning. */
  private val noAnswer = Runnable {
    val waiting = pending.toList()
    pending.clear()
    waiting.forEach { it.reject("no answer from the push service", "error") }
  }
  private val listener: (PushStore.Event) -> Unit = { event -> main.post { onPushEvent(event) } }
  private var webView: WebView? = null

  override fun load(webView: WebView) {
    super.load(webView)
    this.webView = webView
    PushStore.addListener(listener)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // MainActivity has already kept the tap's page (PushStore.rememberTap). The
    // app was running: tell the page, which then asks for it (takeOpenUrl). The
    // WebView fires no visibilitychange when the app comes back to the front.
    main.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('svrz-push-tap'))", null) }
  }

  @Command
  fun state(invoke: Invoke) {
    invoke.resolve(
      JSObject()
        .put("permission", permission())
        .put("subscription", PushStore.subscription(activity)?.toJson())
        .put("distributor", UnifiedPush.getAckDistributor(activity)),
    )
  }

  @Command
  fun subscribe(invoke: Invoke) {
    val args = invoke.parseArgs(PushSubscribeArgs::class.java)
    if (args.vapidPublicKey.isBlank()) return invoke.reject("missing server key", "error")
    pendingVapid = args.vapidPublicKey
    if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", invoke, "afterPermission")
      return
    }
    start(invoke)
  }

  @PermissionCallback
  private fun afterPermission(invoke: Invoke) {
    if (getPermissionState("notifications") == PermissionState.GRANTED) start(invoke)
    else invoke.reject("notifications not allowed", "denied")
  }

  @Command
  fun unsubscribe(invoke: Invoke) {
    UnifiedPush.unregister(activity)
    PushStore.clear(activity)
    invoke.resolve(JSObject().put("unsubscribed", true))
  }

  /** The page asks once it is up, and on every `svrz-push-tap`. */
  @Command
  fun takeOpenUrl(invoke: Invoke) {
    invoke.resolve(JSObject().put("url", PushStore.takeOpenUrl()))
  }

  private fun permission(): String = when {
    !NotificationManagerCompat.from(activity).areNotificationsEnabled() &&
      (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) -> "denied"
    Build.VERSION.SDK_INT < 33 -> "granted"
    else -> when (getPermissionState("notifications")) {
      PermissionState.GRANTED -> "granted"
      PermissionState.DENIED -> "denied"
      else -> "default"
    }
  }

  private fun start(invoke: Invoke) {
    if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
      return invoke.reject("notifications are off for the app", "denied")
    }
    // The app is a distributor itself (embedded FCM distributor), so "no
    // distributor" means no distributor APP: then Google's push, if possible.
    if (UnifiedPush.getDistributors(activity).none { it != activity.packageName }) {
      if (!hasPlayServices()) return invoke.reject("no push service on this phone", "no-distributor")
      UnifiedPush.saveDistributor(activity, activity.packageName)
      return register(invoke)
    }
    UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { useDefault ->
      main.post {
        if (useDefault) register(invoke)
        else UnifiedPush.tryPickDistributor(activity) { picked ->
          main.post { if (picked) register(invoke) else invoke.reject("no push service picked", "no-distributor") }
        }
      }
    }
  }

  private fun register(invoke: Invoke) {
    val vapid = pendingVapid ?: return invoke.reject("missing server key", "error")
    pending += invoke
    // A distributor app that was never opened, or was force-stopped, gets no
    // broadcasts and never answers. The built-in one answers within a second.
    main.removeCallbacks(distributorSilent)
    main.removeCallbacks(noAnswer)
    if (UnifiedPush.getSavedDistributor(activity) != activity.packageName) {
      main.postDelayed(distributorSilent, DISTRIBUTOR_ANSWER_MS)
    }
    main.postDelayed(noAnswer, NO_ANSWER_MS)
    try {
      UnifiedPush.register(activity, messageForDistributor = activity.getString(R.string.app_name), vapid = vapid)
    } catch (_: UnifiedPush.VapidNotValidException) {
      pending -= invoke
      main.removeCallbacks(distributorSilent)
      main.removeCallbacks(noAnswer)
      invoke.reject("invalid server key", "error")
    }
  }

  /** The distributor app did not answer in time: Google's push if possible, else name the app to open. */
  private fun onDistributorSilent() {
    val waiting = pending.toList()
    if (waiting.isEmpty()) return
    pending.clear()
    if (hasPlayServices()) {
      UnifiedPush.saveDistributor(activity, activity.packageName)
      waiting.drop(1).forEach { pending += it }
      register(waiting.first())
      return
    }
    val name = UnifiedPush.getSavedDistributor(activity)?.let(::appLabel) ?: "UnifiedPush"
    waiting.forEach { it.reject(name, "distributor-silent") }
  }

  private fun onPushEvent(event: PushStore.Event) {
    main.removeCallbacks(distributorSilent)
    main.removeCallbacks(noAnswer)
    val waiting = pending.toList()
    pending.clear()
    when (event) {
      is PushStore.Event.NewEndpoint ->
        waiting.forEach { it.resolve(JSObject().put("subscription", event.subscription.toJson())) }
      is PushStore.Event.Failed -> waiting.forEach { it.reject(event.reason, "error") }
      PushStore.Event.Unregistered -> waiting.forEach { it.reject("unregistered", "error") }
    }
  }

  private fun hasPlayServices(): Boolean = runCatching {
    val pm = activity.packageManager
    if (Build.VERSION.SDK_INT >= 33) {
      pm.getPackageInfo(PLAY_SERVICES, PackageManager.PackageInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(PLAY_SERVICES, 0)
    }
  }.isSuccess

  private fun appLabel(packageName: String): String? = runCatching {
    val pm = activity.packageManager
    val info = if (Build.VERSION.SDK_INT >= 33) {
      pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0))
    } else {
      @Suppress("DEPRECATION")
      pm.getApplicationInfo(packageName, 0)
    }
    pm.getApplicationLabel(info).toString()
  }.getOrNull()

  private companion object {
    /** Google Play services: what the embedded FCM distributor registers through. */
    const val PLAY_SERVICES = "com.google.android.gms"
    /** How long a distributor app gets to answer a registration before the fallback. */
    const val DISTRIBUTOR_ANSWER_MS = 10_000L
    /** How long any registration may take, the fallback included. */
    const val NO_ANSWER_MS = 30_000L
  }
}
