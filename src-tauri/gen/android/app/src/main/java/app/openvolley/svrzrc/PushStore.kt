package app.openvolley.svrzrc

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArraySet

/**
 * This phone's push subscription (endpoint + Web Push keys), the hand-off from
 * [SvrzPushService] to a live [PushPlugin], and the notifications themselves.
 */
object PushStore {
  data class Subscription(val endpoint: String, val p256dh: String, val auth: String) {
    /** Same shape as a browser PushSubscription.toJSON(), which /api/push/subscribe reads. */
    fun toJson(): JSONObject = JSONObject()
      .put("endpoint", endpoint)
      .put("keys", JSONObject().put("p256dh", p256dh).put("auth", auth))
  }

  sealed interface Event {
    data class NewEndpoint(val subscription: Subscription) : Event
    data class Failed(val reason: String) : Event
    data object Unregistered : Event
  }

  private val listeners = CopyOnWriteArraySet<(Event) -> Unit>()

  fun addListener(listener: (Event) -> Unit) = listeners.add(listener)
  fun dispatch(event: Event) = listeners.forEach { it(event) }

  private fun prefs(context: Context) = context.getSharedPreferences("push", Context.MODE_PRIVATE)

  fun save(context: Context, s: Subscription) = prefs(context).edit {
    putString("endpoint", s.endpoint)
    putString("p256dh", s.p256dh)
    putString("auth", s.auth)
  }

  fun subscription(context: Context): Subscription? {
    val p = prefs(context)
    return Subscription(
      p.getString("endpoint", null) ?: return null,
      p.getString("p256dh", null) ?: return null,
      p.getString("auth", null) ?: return null,
    )
  }

  fun clear(context: Context) = prefs(context).edit {
    remove("endpoint")
    remove("p256dh")
    remove("auth")
  }

  // ── Notifications ────────────────────────────────────────────────────

  private const val CHANNEL = "svrz-news"
  private const val EXTRA_URL = "app.openvolley.svrzrc.PUSH_URL"
  private const val EXTRA_TAP = "app.openvolley.svrzrc.PUSH_TAP"
  /** An in-app path the API sends ("/spiele", "/boerse?x=1"), never another site. */
  private val APP_PATH = Regex("^/(?!/)[A-Za-z0-9/_\\-?=&%.#~]*$")

  /** A secret only this install knows: MainActivity is exported, so any app can
   *  start it with extras, and only our own notification may pick the page. */
  private fun tapSecret(context: Context): String {
    val p = prefs(context)
    p.getString("tap_secret", null)?.let { return it }
    val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
    val secret = bytes.joinToString("") { "%02x".format(it) }
    p.edit { putString("tap_secret", secret) }
    return secret
  }

  /** The page the last notification tap asked for, until the page takes it.
   *  Kept here, not in the plugin: after Android killed the app, the tap can
   *  arrive (MainActivity.onNewIntent) before Tauri has loaded its plugins. */
  @Volatile private var openUrl: String? = null

  /** MainActivity calls this for every intent that starts or reaches it. */
  fun rememberTap(context: Context, intent: Intent?): Boolean {
    val url = tapUrl(context, intent) ?: return false
    openUrl = url
    return true
  }

  fun takeOpenUrl(): String? = openUrl.also { openUrl = null }

  /** The page a tap on our own notification asks for, or null. */
  private fun tapUrl(context: Context, intent: Intent?): String? {
    intent ?: return null
    val url = runCatching { intent.getStringExtra(EXTRA_URL) }.getOrNull() ?: return null
    val tap = runCatching { intent.getStringExtra(EXTRA_TAP) }.getOrNull() ?: return null
    if (tap != tapSecret(context) || !APP_PATH.matches(url)) return null
    intent.removeExtra(EXTRA_URL)
    return url
  }

  fun show(context: Context, title: String, body: String, url: String?, tag: String?) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, context.getString(R.string.push_channel_name), NotificationManager.IMPORTANCE_DEFAULT),
      )
    }
    val open = Intent(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_TAP, tapSecret(context))
      .apply { if (url != null && APP_PATH.matches(url)) putExtra(EXTRA_URL, url) }
    val id = (tag ?: "$title|$body").hashCode()
    val tapIntent = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_notify)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(tapIntent)
      .setAutoCancel(true)
      .build()
    runCatching { NotificationManagerCompat.from(context).notify(tag, id, notification) }
  }
}

/**
 * Receives from the coach's UnifiedPush distributor (Sunup, ntfy, …, or the
 * built-in one that goes through Google Play services). Messages are the API's
 * Web Push, already decrypted by the connector; the payload is the JSON
 * public/push-sw.js shows in a browser: {title, body, url, tag}.
 */
class SvrzPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val keys = endpoint.pubKeySet
    if (keys == null) {
      // A distributor without Web Push encryption cannot receive from the API.
      PushStore.dispatch(PushStore.Event.Failed("distributor gave no Web Push keys"))
      return
    }
    val subscription = PushStore.Subscription(endpoint.url, keys.pubKey, keys.auth)
    PushStore.save(this, subscription)
    PushStore.dispatch(PushStore.Event.NewEndpoint(subscription))
  }

  override fun onMessage(message: PushMessage, instance: String) {
    if (!message.decrypted) return
    val data = runCatching { JSONObject(String(message.content, Charsets.UTF_8)) }.getOrNull() ?: return
    PushStore.show(
      this,
      title = data.optString("title").ifBlank { "SR-Coaching" },
      body = data.optString("body"),
      url = data.optString("url").ifBlank { null },
      tag = data.optString("tag").ifBlank { null },
    )
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    PushStore.dispatch(PushStore.Event.Failed(reason.name))
  }

  override fun onUnregistered(instance: String) {
    PushStore.clear(this)
    PushStore.dispatch(PushStore.Event.Unregistered)
  }
}
