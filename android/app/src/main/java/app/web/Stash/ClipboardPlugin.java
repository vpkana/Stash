package app.web.Stash;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Reads the system clipboard, for the note editor's selection bar.
 *
 * The browser's own clipboard is only half usable inside a WebView: writing
 * works, but `navigator.clipboard.readText()` always rejects with
 * `NotAllowedError`, because the permission it needs cannot be requested by a
 * page in a WebView (there is no prompt to answer). The platform's own Cut /
 * Copy menu never had that problem — it is native — and neither does this: the
 * bar's Paste reads through the same `ClipboardManager` the system does.
 *
 * Read only, deliberately. Copy and Cut go through `document.execCommand`,
 * which acts on the selection the browser already owns and needs no bridge.
 */
@CapacitorPlugin(name = "Clipboard")
public class ClipboardPlugin extends Plugin {

    @PluginMethod
    public void read(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", readClipboard());
        call.resolve(result);
    }

    private String readClipboard() {
        ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (manager == null || !manager.hasPrimaryClip()) return "";
        ClipData clip = manager.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) return "";
        CharSequence text = clip.getItemAt(0).coerceToText(getContext());
        return text == null ? "" : text.toString();
    }
}
