package app.web.Stash;

import android.content.Context;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.View;
import android.widget.PopupMenu;

/**
 * The action mode Android would use for a WebView text selection, with no surface
 * of its own.
 *
 * ## Why this exists
 *
 * Android renders the floating Cut / Copy / Paste menu as an {@link ActionMode}.
 * Over a WebView, Chromium asks the view for one
 * ({@code SelectionPopupControllerImpl.showActionModeOrClearOnFailure}) and then
 * keeps that exact object: it calls {@code invalidate()}, {@code hide()} and
 * {@code finish()} on it, and it treats a {@code null} answer as "selection is
 * gone" and clears the selection. That last part is why simply refusing the mode
 * also kills the selection and its handles — and why the menu keeps coming back
 * when the refusal is written as "return null and let the window decide".
 *
 * So the slot is filled, not refused. This object is a real, working
 * {@link ActionMode}: it carries the WebView's own callback, builds its menu so
 * the WebView's internal state is exactly what it would be with the native menu,
 * and then clears it and never attaches a window of its own. Nothing is drawn,
 * while selection, handles, dragging and caret placement are all untouched —
 * they are the WebView's, not the action mode's.
 *
 * ## What it is not
 *
 * This is not a reflection hack into {@code FloatingToolbar} or
 * {@code PhoneWindow}: every class used here is public API. It also does not
 * disable selection, does not consume touches and does not touch the Activity's
 * ActionBar or theme. The WebView's own selection handles are shown by its
 * renderer and do not depend on this object rendering anything.
 *
 * ## Lifecycle
 *
 * The callback's {@code onCreateActionMode} / {@code onPrepareActionMode} run
 * once when the mode is created, so the WebView believes the mode started (which
 * is what keeps the selection alive), and {@code onDestroyActionMode} runs when
 * the WebView finishes the mode — which is the same moment the default
 * implementation would have called it. `finish()` is idempotent: the WebView can
 * ask twice, and re-entering the callback could otherwise destroy state twice.
 */
final class EmptySelectionActionMode extends ActionMode {

    private final Callback callback;
    private final Context context;
    /** Owns the menu and its inflater; created but never shown. */
    private final PopupMenu menuHost;
    private final Menu menu;
    private final MenuInflater inflater;

    private CharSequence title;
    private CharSequence subtitle;
    private View customView;
    private int type = ActionMode.TYPE_FLOATING;
    private boolean titleOptional;
    private boolean finished;

    EmptySelectionActionMode(Context context, Callback callback) {
        this.callback = callback;
        this.context = context;

        /*
         * A Menu object is required by the ActionMode contract, and Chromium
         * populates it in onPrepareActionMode. PopupMenu is the public API that
         * hands one out together with an inflater; it is never shown.
         */
        this.menuHost = new PopupMenu(context, new View(context));
        this.menu = menuHost.getMenu();
        this.inflater = menuHost.getMenuInflater();

        /*
         * Let the WebView build its selection state exactly as it would for the
         * native menu, then throw the items away. The WebView's helper records
         * the mode and its selected text here; the items are what would have
         * been drawn, and they are the one thing this class must not keep.
         */
        callback.onCreateActionMode(this, menu);
        callback.onPrepareActionMode(this, menu);
        menu.clear();
    }

    @Override
    public Menu getMenu() {
        return menu;
    }

    @Override
    public MenuInflater getMenuInflater() {
        return inflater;
    }

    @Override
    public CharSequence getTitle() {
        return title;
    }

    @Override
    public CharSequence getSubtitle() {
        return subtitle;
    }

    @Override
    public View getCustomView() {
        return customView;
    }

    @Override
    public void setTitle(CharSequence title) {
        this.title = title;
    }

    @Override
    public void setTitle(int resId) {
        // Never displayed; the name is kept only so the contract is honoured.
        this.title = context.getString(resId);
    }

    @Override
    public void setSubtitle(CharSequence subtitle) {
        this.subtitle = subtitle;
    }

    @Override
    public void setSubtitle(int resId) {
        this.subtitle = context.getString(resId);
    }

    @Override
    public void setCustomView(View view) {
        this.customView = view;
    }

    @Override
    public void setTitleOptionalHint(boolean titleOptional) {
        this.titleOptional = titleOptional;
    }

    @Override
    public boolean getTitleOptionalHint() {
        return titleOptional;
    }

    @Override
    public boolean isTitleOptional() {
        return false;
    }

    @Override
    public void setType(int type) {
        this.type = type;
    }

    @Override
    public int getType() {
        return type;
    }

    /**
     * Refresh the WebView's own menu model, then discard the items again.
     *
     * Chromium calls this when the selection or its capabilities change. Running
     * the callback keeps the WebView's cached state honest; clearing afterwards
     * keeps the menu empty.
     */
    @Override
    public void invalidate() {
        if (finished) return;
        menu.clear();
        callback.onPrepareActionMode(this, menu);
        menu.clear();
    }

    /**
     * End the mode. Chromium calls this when the selection collapses or the
     * WebView loses focus, and expects the callback that it supplied to be told.
     */
    @Override
    public void finish() {
        if (finished) return;
        finished = true;
        menu.clear();
        callback.onDestroyActionMode(this);
    }
}
