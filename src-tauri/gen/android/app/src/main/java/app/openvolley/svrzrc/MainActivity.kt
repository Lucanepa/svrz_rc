package app.openvolley.svrzrc

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Dark bar icons whatever the phone's theme: the app is light-only
    // (src/index.css), so light icons would vanish against it.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.BLACK),
      navigationBarStyle = SystemBarStyle.light(Color.TRANSPARENT, Color.BLACK),
    )
    super.onCreate(savedInstanceState)
    keepWebViewClearOfSystemBars()
  }

  // Android 15+ always draws the app edge to edge (targetSdk 36 can no longer
  // opt out), so the page ran under the clock and the battery. The page cannot
  // fix that itself: the WebView's env(safe-area-inset-*) only reports the bars
  // reliably from WebView 140 and with viewport-fit=cover, which the web build
  // does not set. So the WebView's parent is padded by the bars and the
  // keyboard, the way an app that is not edge to edge would be, and the page
  // is told the bars are zero so the env() paddings it already has (bottom nav,
  // sheets) are not added on top. The bars' area shows the window background
  // (values/themes.xml), the page's own stone-100.
  //
  // The bars are zeroed rather than the insets consumed: a consumed dispatch
  // leaves the WebView's safe-area values stale (crbug.com/461332423).
  private fun keepWebViewClearOfSystemBars() {
    val bars = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val barInsets = insets.getInsets(bars)
      val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(barInsets.left, barInsets.top, barInsets.right, maxOf(barInsets.bottom, imeBottom))
      WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.NONE).build()
    }
  }
}
