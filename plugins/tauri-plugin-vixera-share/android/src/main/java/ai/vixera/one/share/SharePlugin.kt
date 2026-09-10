package ai.vixera.one.share

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

@InvokeArg
class SecureKeyArgs {
  lateinit var key: String
}

@InvokeArg
class SecureSetArgs {
  lateinit var key: String
  lateinit var value: String
}

/**
 * Vixera One share/capture bridge (`ai.vixera.one.share`).
 *
 * Responsibilities, all explicit and user-initiated:
 *  - Intake of `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intents delivered to the
 *    app's MainActivity (the intent-filters are declared on the app manifest,
 *    see docs/build-android.md). Content URIs are copied into
 *    `cacheDir/vixera-shares/<uuid>.<ext>` so the temporary URI grant from the
 *    sending app does not matter once the share sheet closes.
 *  - A queue (`ShareInbox`) answered by `getPendingShares` / `clearPendingShares`
 *    plus a `share` event when the queue changes.
 *  - `secureGet` / `secureSet` / `secureDelete`: opaque string secrets in
 *    `EncryptedSharedPreferences("ai.vixera.one.secure")` under an Android
 *    Keystore AES256-GCM master key. Values are never logged.
 *
 * Nothing here reads the screen, runs in the background, or draws over other
 * apps. No accessibility service, no overlays (Phase 1 brief).
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    private const val TAG = "VixeraShare"
    private const val CACHE_DIR = "vixera-shares"
    private const val SECURE_PREFS = "ai.vixera.one.secure"
    private const val EVENT_SHARE = "share"
  }

  private val inbox = ShareInbox()

  override fun load(webView: WebView) {
    super.load(webView)
    // Cold start from the share sheet: the launching intent is the share.
    activity.intent?.let { handleIntent(it) }
  }

  /** Warm start (launchMode singleTask): a new share arrives while running. */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent)
    // Make the share idempotent across configuration changes / relaunches.
    activity.intent = intent
  }

  // ---------------------------------------------------------------------------
  // Share intake
  // ---------------------------------------------------------------------------

  private fun handleIntent(intent: Intent) {
    val action = intent.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    // A share intent is consumed exactly once even if load()/onNewIntent see it twice.
    if (intent.getBooleanExtra("ai.vixera.one.share.consumed", false)) return
    intent.putExtra("ai.vixera.one.share.consumed", true)

    val received = mutableListOf<ShareItem>()
    val title = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() }
    val now = nowRfc3339()

    val streams: List<Uri> = when (action) {
      Intent.ACTION_SEND ->
        listOfNotNull(intent.getParcelableExtraCompat(Intent.EXTRA_STREAM))
      else ->
        intent.getParcelableArrayListExtraCompat(Intent.EXTRA_STREAM) ?: emptyList()
    }

    for (uri in streams) {
      try {
        received.add(cacheStream(uri, intent.type, title, now))
      } catch (e: Exception) {
        // Log the failure kind only; never the content.
        Log.w(TAG, "could not cache shared stream: ${e.javaClass.simpleName}")
      }
    }

    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
    if (text != null && streams.isEmpty()) {
      val trimmed = text.trim()
      val kind = if (isHttpUrl(trimmed)) "url" else "text"
      received.add(
        ShareItem(
          id = UUID.randomUUID().toString(),
          kind = kind,
          text = trimmed,
          mimeType = intent.type ?: "text/plain",
          title = title,
          receivedAt = now
        )
      )
    }

    if (received.isEmpty()) return
    inbox.addAll(received)
    trigger(EVENT_SHARE, inbox.toJson())
  }

  private fun cacheStream(uri: Uri, intentType: String?, title: String?, now: String): ShareItem {
    val resolver = activity.contentResolver
    val mime = resolver.getType(uri) ?: intentType?.takeIf { !it.contains('*') } ?: "application/octet-stream"
    val displayName = queryDisplayName(uri) ?: uri.lastPathSegment?.substringAfterLast('/')
    val ext = displayName?.substringAfterLast('.', "")?.takeIf { it.isNotEmpty() && it.length <= 8 }
      ?: MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
      ?: "bin"

    val dir = File(activity.cacheDir, CACHE_DIR).apply { mkdirs() }
    val id = UUID.randomUUID().toString()
    val target = File(dir, "$id.$ext")
    var size = 0L
    resolver.openInputStream(uri).use { input ->
      requireNotNull(input) { "content provider returned no stream" }
      FileOutputStream(target).use { output ->
        size = input.copyTo(output)
      }
    }

    val kind = if (mime.startsWith("image/")) "image" else "file"
    return ShareItem(
      id = id,
      kind = kind,
      path = target.absolutePath,
      mimeType = mime,
      filename = displayName,
      sizeBytes = size,
      title = title,
      receivedAt = now
    )
  }

  private fun queryDisplayName(uri: Uri): String? {
    if (uri.scheme != "content") return null
    return try {
      activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
      }
    } catch (e: Exception) {
      null
    }
  }

  private fun isHttpUrl(value: String): Boolean {
    if (value.contains('\n') || value.contains(' ')) return false
    val uri = try { Uri.parse(value) } catch (e: Exception) { return false }
    val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
    return (scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank()
  }

  private fun nowRfc3339(): String {
    val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return fmt.format(Date())
  }

  @Suppress("DEPRECATION")
  private fun Intent.getParcelableExtraCompat(name: String): Uri? =
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
      getParcelableExtra(name, Uri::class.java)
    } else {
      getParcelableExtra(name) as? Uri
    }

  @Suppress("DEPRECATION")
  private fun Intent.getParcelableArrayListExtraCompat(name: String): ArrayList<Uri>? =
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
      getParcelableArrayListExtra(name, Uri::class.java)
    } else {
      getParcelableArrayListExtra(name)
    }

  // ---------------------------------------------------------------------------
  // Commands: share queue
  // ---------------------------------------------------------------------------

  @Command
  fun getPendingShares(invoke: Invoke) {
    invoke.resolve(inbox.toJson())
  }

  /**
   * Empties the queue and deletes the cached files of the cleared items. The
   * TypeScript side calls this only after the bytes have been ingested.
   */
  @Command
  fun clearPendingShares(invoke: Invoke) {
    for (item in inbox.clear()) {
      item.path?.let { path ->
        try {
          File(path).delete()
        } catch (e: Exception) {
          Log.w(TAG, "could not delete cached share: ${e.javaClass.simpleName}")
        }
      }
    }
    invoke.resolve()
  }

  // ---------------------------------------------------------------------------
  // Commands: secure storage (Android Keystore-backed)
  // ---------------------------------------------------------------------------

  private val securePrefs by lazy {
    val context: Context = activity.applicationContext
    val masterKey = MasterKey.Builder(context)
      .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
      .build()
    EncryptedSharedPreferences.create(
      context,
      SECURE_PREFS,
      masterKey,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )
  }

  @Command
  fun secureGet(invoke: Invoke) {
    val args = invoke.parseArgs(SecureKeyArgs::class.java)
    try {
      val result = JSObject()
      result.put("value", securePrefs.getString(args.key, null))
      invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject("secure storage read failed for key ${args.key}", "secure_storage")
    }
  }

  @Command
  fun secureSet(invoke: Invoke) {
    val args = invoke.parseArgs(SecureSetArgs::class.java)
    try {
      val ok = securePrefs.edit().putString(args.key, args.value).commit()
      if (ok) invoke.resolve() else invoke.reject("secure storage write failed for key ${args.key}", "secure_storage")
    } catch (e: Exception) {
      invoke.reject("secure storage write failed for key ${args.key}", "secure_storage")
    }
  }

  @Command
  fun secureDelete(invoke: Invoke) {
    val args = invoke.parseArgs(SecureKeyArgs::class.java)
    try {
      securePrefs.edit().remove(args.key).commit()
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject("secure storage delete failed for key ${args.key}", "secure_storage")
    }
  }
}
