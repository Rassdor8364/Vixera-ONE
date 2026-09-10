package ai.vixera.one.share

import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.util.concurrent.CopyOnWriteArrayList

/**
 * One object the user explicitly shared into Vixera. Mirrors `ShareItem` in the
 * Rust plugin (`src/models.rs`) and `apps/desktop/src/platform/share.ts`; field
 * names are camelCase on every side.
 *
 * This is a platform object, not a domain object: it carries no user id and no
 * Vixera identifiers. The TypeScript ingestion pipeline turns it into an
 * `IngestItem` and the spine store attaches `currentUser()`.
 */
data class ShareItem(
  val id: String,
  /** "file" | "image" | "url" | "text" */
  val kind: String,
  /** Absolute path of the cached copy (file/image), else null. */
  val path: String? = null,
  /** URL or text payload (url/text), else null. */
  val text: String? = null,
  val mimeType: String? = null,
  val filename: String? = null,
  val sizeBytes: Long? = null,
  /** EXTRA_SUBJECT of the sharing intent, when present. */
  val title: String? = null,
  /** RFC 3339 UTC timestamp. */
  val receivedAt: String
) {
  fun toJson(): JSObject {
    val obj = JSObject()
    obj.put("id", id)
    obj.put("kind", kind)
    obj.put("path", path)
    obj.put("text", text)
    obj.put("mimeType", mimeType)
    obj.put("filename", filename)
    obj.put("sizeBytes", sizeBytes)
    obj.put("title", title)
    obj.put("receivedAt", receivedAt)
    return obj
  }
}

/**
 * Thread-safe queue of shares received since the last `clearPendingShares`.
 *
 * Shares can arrive before the webview has loaded (cold start from the share
 * sheet) or while the app is running (`onNewIntent`). Either way they are queued
 * here; the `share` event is only a hint that the queue changed, and the
 * TypeScript side always reads the queue with `getPendingShares` so nothing is
 * lost when no listener is attached yet.
 */
class ShareInbox {
  private val items = CopyOnWriteArrayList<ShareItem>()

  fun add(item: ShareItem) {
    items.add(item)
  }

  fun addAll(newItems: List<ShareItem>) {
    items.addAll(newItems)
  }

  fun snapshot(): List<ShareItem> = items.toList()

  fun clear(): List<ShareItem> {
    val cleared = items.toList()
    items.clear()
    return cleared
  }

  fun isEmpty(): Boolean = items.isEmpty()

  fun toJson(): JSObject {
    val array = JSArray()
    for (item in items) {
      array.put(item.toJson())
    }
    val obj = JSObject()
    obj.put("items", array)
    return obj
  }
}
