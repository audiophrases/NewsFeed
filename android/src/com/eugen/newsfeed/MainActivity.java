package com.eugen.newsfeed;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * NewsFeed on the phone: the NewsFeed web app, plus what a web page can't do itself. Many sites
 * turn NewsFeed's server away (Google News' article links, outlets behind Cloudflare's bot check)
 * but let a phone in, and a web page can't read another site's page. So when NewsFeed asks, the
 * app opens an article in a browser view of its own, the way Chrome would (Google News forwards
 * it to the outlet), and hands the page back to NewsFeed, which shows it in its reader. When
 * something is in the way (a cookie choice, a check), the page is shown: tap through it, then
 * Reading mode.
 *
 * NewsFeed's page and the app talk through a message channel the app gives that page only (not to
 * frames in it, nor to any other site). Messages are JSON:
 *   page -> app: read {id, url}, show {id, hint}, hide {id}, cancel {id}, toast {text},
 *                save {name, text, mime}
 *   app -> page: address {id, url}, page {id, url, title, html, user, challenge}, stuck {id, reason},
 *                failed {id, error}, closed {id}
 */
public class MainActivity extends Activity {

    /** What the app sends NewsFeed's page with the channel's port: the bridge's name and version. */
    private static final String HELLO = "newsfeed-android:1";
    private static final int PICK_FILE = 1, SAVE_FILE = 2;
    /** How long a page is given to settle (scripts filling it in) before it's read. */
    private static final long SETTLE_MS = 1500;
    /** How long an article may take to reach its outlet before it's shown to you. */
    private static final long STUCK_MS = 20000;
    /** How long a bot check may take to let the page through by itself. */
    private static final long CHECK_MS = 8000;
    /** Most of a page's HTML handed to NewsFeed (scripts and styles left out first). */
    private static final int MAX_HTML = 3_000_000;

    /**
     * Run in the article's page to hand it to NewsFeed: a copy of its document without scripts
     * (but with the article data some pages describe themselves with), styles and media, and
     * whether it is a bot check still running. The browser turns the object into JSON itself.
     */
    private static final String READ_PAGE_JS = "(function () {\n"
            + "  try {\n"
            + "    var copy = document.documentElement.cloneNode(true);\n"
            + "    var drop = copy.querySelectorAll('script:not([type=\"application/ld+json\"]),style,svg,"
            + "iframe,template,link,canvas,video,audio,object,embed');\n"
            + "    for (var i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);\n"
            + "    var check = !!document.querySelector('#challenge-form,#challenge-running,#cf-challenge-running,"
            + "script[src*=\"/cdn-cgi/challenge-platform/\"]');\n"
            + "    return { url: location.href, title: document.title, html: copy.outerHTML.slice(0, " + MAX_HTML + "),"
            + " challenge: check };\n"
            + "  } catch (e) {\n"
            + "    return { url: location.href, error: String(e) };\n"
            + "  }\n"
            + "})()";

    private final Handler ui = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView main;
    private WebView article;
    private FrameLayout.LayoutParams articleLayout;
    private View bar;
    private TextView barTitle;
    private TextView barHint;
    private ProgressBar progress;
    private TextView banner;

    private Uri appUri;
    private String appOrigin;
    private WebMessagePort port;
    private boolean mainFailed;

    /** The article being read: its id from NewsFeed, and how far it got. */
    private int readId;
    private boolean addressSent, pageSent, stuckSent, showing;

    private ValueCallback<Uri[]> fileCallback;
    private String saveText;

    private final Runnable readLater = () -> readPage(false);
    private final Runnable stuckLater = () -> {
        if (!pageSent && !showing) stuck("slow");
    };

    // ---- set-up -------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        appUri = Uri.parse(getString(R.string.app_url));
        appOrigin = originOf(appUri);
        // Personal app: lets a computer inspect its pages (chrome://inspect) over USB debugging.
        WebView.setWebContentsDebuggingEnabled(true);

        root = new FrameLayout(this);
        root.setBackgroundColor(color(R.color.background));

        int barHeight = dp(64);
        article = createArticleView();
        articleLayout = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        articleLayout.topMargin = barHeight;
        // Behind NewsFeed's page, but laid out and running at full speed (an invisible view would be slowed).
        root.addView(article, articleLayout);

        main = new WebView(this);
        main.setBackgroundColor(color(R.color.background));
        WebSettings settings = main.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        main.setWebViewClient(new MainClient());
        main.setWebChromeClient(new MainChrome());
        root.addView(main, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        bar = createBar(barHeight);
        bar.setVisibility(View.GONE);
        root.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barHeight, Gravity.TOP));

        banner = new TextView(this);
        banner.setGravity(Gravity.CENTER);
        banner.setPadding(dp(32), 0, dp(32), 0);
        banner.setTextColor(color(R.color.muted));
        banner.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        banner.setBackgroundColor(color(R.color.background));
        banner.setText(R.string.connecting);
        banner.setOnClickListener(v -> {
            if (mainFailed) {
                banner.setText(R.string.connecting);
                main.reload();
            }
        });
        root.addView(banner, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        drawBehindSystemBars();
        listenForBack();

        CookieManager.getInstance().setAcceptCookie(true);
        if (state == null || main.restoreState(state) == null) main.loadUrl(appUri.toString());
    }

    private WebView createArticleView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        // Cookie choices made inside consent frames count, as in Chrome.
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.setWebViewClient(new ArticleClient());
        view.setWebChromeClient(new ArticleChrome());
        return view;
    }

    /** The bar over an article shown to you: back to NewsFeed, where it is, and Reading mode. */
    private View createBar(int height) {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(color(R.color.bar));
        column.setElevation(dp(4));
        column.setClickable(true); // touches on the bar don't reach the page under it

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(4), 0, dp(8), 0);

        ImageButton close = new ImageButton(this);
        close.setImageResource(R.drawable.ic_back);
        close.setBackgroundResource(attribute(android.R.attr.selectableItemBackgroundBorderless));
        close.setContentDescription(getString(R.string.back_to_newsfeed));
        close.setOnClickListener(v -> closedByYou());
        row.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));

        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setPadding(dp(4), 0, dp(8), 0);
        barTitle = new TextView(this);
        barTitle.setTextColor(color(R.color.text));
        barTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        barTitle.setSingleLine(true);
        barTitle.setEllipsize(TextUtils.TruncateAt.END);
        barTitle.setTypeface(barTitle.getTypeface(), android.graphics.Typeface.BOLD);
        barHint = new TextView(this);
        barHint.setTextColor(color(R.color.muted));
        barHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        barHint.setMaxLines(2);
        barHint.setEllipsize(TextUtils.TruncateAt.END);
        texts.addView(barTitle);
        texts.addView(barHint);
        row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        TextView reading = new TextView(this);
        reading.setText(R.string.reading_mode);
        reading.setTextColor(color(R.color.accent));
        reading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        reading.setTypeface(reading.getTypeface(), android.graphics.Typeface.BOLD);
        reading.setGravity(Gravity.CENTER);
        reading.setPadding(dp(12), 0, dp(12), 0);
        reading.setBackgroundResource(attribute(android.R.attr.selectableItemBackground));
        reading.setOnClickListener(v -> readPage(true));
        row.addView(reading, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));

        column.addView(row, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(color(R.color.accent)));
        column.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));
        return column;
    }

    /**
     * Draws under the status and navigation bars (as Android 15 and later require of apps for
     * them) and keeps the content out from under them, and from under the keyboard.
     */
    private void drawBehindSystemBars() {
        Window window = getWindow();
        boolean light = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                != Configuration.UI_MODE_NIGHT_YES;
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int both = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(light ? both : 0, both);
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (light && Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            window.getDecorView().setSystemUiVisibility(flags);
        }
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets edges = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime()
                        | WindowInsets.Type.displayCutout());
                view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
                return WindowInsets.CONSUMED;
            }
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();
    }

    /** Back: from an article shown to you, back to NewsFeed; in NewsFeed, its own back (the reader closes). */
    private void listenForBack() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> {
                if (!back()) moveTaskToBack(true);
            });
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (!back()) super.onBackPressed();
    }

    private boolean back() {
        if (showing) {
            closedByYou();
            return true;
        }
        if (main.canGoBack()) {
            main.goBack();
            return true;
        }
        return false;
    }

    // ---- NewsFeed's page --------------------------------------------------------------------

    private class MainClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Frames in NewsFeed (a site's own page, shown at your request) go their own way.
            if (!request.isForMainFrame()) return false;
            return leaveFor(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return leaveFor(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            mainFailed = false;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (mainFailed) return;
            banner.setVisibility(View.GONE);
            if (appOrigin.equals(originOf(Uri.parse(url)))) connect();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            mainFailed = true;
            banner.setText(R.string.unreachable);
            banner.setVisibility(View.VISIBLE);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            recreate();
            return true;
        }
    }

    /** NewsFeed stays on its own site: other addresses (Read on…, mail) open in their own apps. */
    private boolean leaveFor(Uri uri) {
        if (appOrigin.equals(originOf(uri))) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto") || scheme.equals("tel")) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                toast(getString(R.string.no_app));
            }
        }
        return true;
    }

    private class MainChrome extends WebChromeClient {
        /** Import: any file (the page checks what it is; some file managers mislabel JSON). */
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            try {
                startActivityForResult(pick, PICK_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast(getString(R.string.no_app));
                return false;
            }
        }
    }

    /**
     * Gives NewsFeed's page (only it: the message goes to that site's main frame) one end of a
     * message channel. Again after every load of the page, which forgets the last one.
     */
    private void connect() {
        if (port != null) port.close();
        WebMessagePort[] ports = main.createWebMessageChannel();
        port = ports[0];
        port.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override
            public void onMessage(WebMessagePort from, WebMessage message) {
                if (from == port) receive(message.getData());
            }
        }, ui);
        main.postWebMessage(new WebMessage(HELLO, new WebMessagePort[] { ports[1] }), Uri.parse(appOrigin));
    }

    private void receive(String data) {
        JSONObject message;
        try {
            message = new JSONObject(data);
        } catch (JSONException | NullPointerException e) {
            return;
        }
        int id = message.optInt("id");
        switch (message.optString("type")) {
            case "read":
                read(id, message.optString("url"));
                break;
            case "show":
                if (id == readId) show(message.optString("hint"));
                break;
            case "hide":
                if (id == readId) hide();
                break;
            case "cancel":
                if (id == readId) stopReading();
                break;
            case "toast":
                toast(message.optString("text"));
                break;
            case "save":
                save(message.optString("name", "newsfeed.json"), message.optString("text"),
                        message.optString("mime", "application/json"));
                break;
            default:
                break;
        }
    }

    private void send(JSONObject message) {
        if (port != null) port.postMessage(new WebMessage(message.toString()));
    }

    private static JSONObject event(String type, int id) {
        JSONObject message = new JSONObject();
        try {
            message.put("type", type).put("id", id);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return message;
    }

    private static JSONObject with(JSONObject message, String key, Object value) {
        try {
            return message.put(key, value);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- the article's page -------------------------------------------------------------------

    /** Opens an article (a Google News link or the outlet's own address) behind NewsFeed's page. */
    private void read(int id, String url) {
        Uri uri = Uri.parse(url);
        if (!isWeb(uri)) {
            send(with(event("failed", id), "error", "Not a web address"));
            return;
        }
        readId = id;
        addressSent = pageSent = stuckSent = false;
        ui.removeCallbacks(readLater);
        ui.removeCallbacks(stuckLater);
        barTitle.setText(uri.getHost());
        article.stopLoading();
        article.loadUrl(url);
        ui.postDelayed(stuckLater, STUCK_MS);
    }

    private void stopReading() {
        ui.removeCallbacks(readLater);
        ui.removeCallbacks(stuckLater);
        hide();
        readId = 0;
        article.stopLoading();
        article.loadUrl("about:blank");
    }

    private class ArticleClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Web pages load here; other schemes (intent:, market:, an app's own) are not followed.
            return !isWeb(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return !isWeb(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            arrivedAt(url);
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            arrivedAt(url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            arrivedAt(url);
            if (readId != 0 && isOutlet(Uri.parse(url))) {
                ui.removeCallbacks(readLater);
                ui.postDelayed(readLater, SETTLE_MS);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (readId != 0 && request.isForMainFrame() && !showing) {
                send(with(event("failed", readId), "error", String.valueOf(error.getDescription())));
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // A heavy page took its renderer down: a fresh view for the next article.
            int id = readId;
            root.removeView(article);
            article.destroy();
            article = createArticleView();
            root.addView(article, 0, articleLayout);
            hide();
            if (id != 0) send(with(event("failed", id), "error", "The page stopped working"));
            readId = 0;
            return true;
        }
    }

    private class ArticleChrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int percent) {
            progress.setProgress(percent);
            progress.setVisibility(percent >= 100 ? View.INVISIBLE : View.VISIBLE);
        }
    }

    /** Each address the article's page reaches: the first outlet page is the article's own address. */
    private void arrivedAt(String url) {
        if (readId == 0 || url == null) return;
        Uri uri = Uri.parse(url);
        if (uri.getHost() != null) barTitle.setText(uri.getHost());
        if (isOutlet(uri)) {
            if (!addressSent) {
                addressSent = true;
                send(with(event("address", readId), "url", url));
            }
        } else if (isConsent(uri) && !stuckSent && !showing) {
            // Google asks for a cookie choice first (in Europe): only you can answer it, once.
            stuck("consent");
        }
    }

    /** Hands the page to NewsFeed: on its own once it has settled, or when you tap Reading mode. */
    private void readPage(boolean byYou) {
        final int id = readId;
        if (id == 0) return;
        article.evaluateJavascript(READ_PAGE_JS, value -> {
            if (id != readId) return;
            JSONObject page;
            try {
                page = new JSONObject(value);
            } catch (JSONException | NullPointerException e) {
                if (byYou) toast("This page can’t be read");
                return;
            }
            if (page.optBoolean("challenge") && !byYou) {
                // A bot check usually lets a phone through by itself in a few seconds; if it needs
                // a tap, it's shown to you.
                ui.postDelayed(() -> {
                    if (id == readId && !pageSent && !showing) stuck("check");
                }, CHECK_MS);
                return;
            }
            with(with(with(page, "type", "page"), "id", id), "user", byYou);
            pageSent = true;
            send(page);
        });
    }

    private void stuck(String reason) {
        stuckSent = true;
        send(with(with(event("stuck", readId), "reason", reason), "url", String.valueOf(article.getUrl())));
    }

    /** Shows the article's page to you, with a hint from NewsFeed on what to do. */
    private void show(String hint) {
        showing = true;
        barHint.setText(hint);
        barHint.setVisibility(TextUtils.isEmpty(hint) ? View.GONE : View.VISIBLE);
        bar.setVisibility(View.VISIBLE);
        main.setVisibility(View.INVISIBLE);
        article.requestFocus();
    }

    private void hide() {
        if (!showing) return;
        showing = false;
        bar.setVisibility(View.GONE);
        main.setVisibility(View.VISIBLE);
        main.requestFocus();
    }

    private void closedByYou() {
        int id = readId;
        hide();
        if (id != 0) send(event("closed", id));
    }

    // ---- files ------------------------------------------------------------------------------

    /** Export: NewsFeed's file, saved where you choose (a web page's download doesn't work in an app). */
    private void save(String name, String text, String mime) {
        saveText = text;
        Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime).putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(create, SAVE_FILE);
        } catch (ActivityNotFoundException e) {
            saveText = null;
            toast(getString(R.string.no_app));
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        } else if (request == SAVE_FILE) {
            String text = saveText;
            saveText = null;
            if (result != RESULT_OK || data == null || data.getData() == null || text == null) return;
            try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                if (out == null) throw new java.io.IOException("no file");
                out.write(text.getBytes(StandardCharsets.UTF_8));
                toast(getString(R.string.saved));
            } catch (Exception e) {
                toast(getString(R.string.not_saved));
            }
        } else {
            super.onActivityResult(request, result, data);
        }
    }

    // ---- life -------------------------------------------------------------------------------

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        main.saveState(state);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        main.onPause();
        article.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        main.onResume();
        article.onResume();
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        if (port != null) port.close();
        main.destroy();
        article.destroy();
        super.onDestroy();
    }

    // ---- small helpers ------------------------------------------------------------------------

    private static boolean isWeb(Uri uri) {
        String scheme = uri.getScheme();
        return ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) && uri.getHost() != null;
    }

    /** Google's own pages (the News redirect, sign-in, cookie choice) aren't the outlet's article. */
    private static boolean isGoogle(String host) {
        return host.equals("google.com") || host.endsWith(".google.com") || host.matches("(www\\.)?google\\.[a-z]{2,3}(\\.[a-z]{2})?");
    }

    private static boolean isConsent(Uri uri) {
        return isWeb(uri) && uri.getHost().toLowerCase(Locale.ROOT).startsWith("consent.");
    }

    private static boolean isOutlet(Uri uri) {
        if (!isWeb(uri)) return false;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        return !isGoogle(host) && !host.startsWith("consent.");
    }

    /** scheme://host[:port], as a page's origin is written. */
    private static String originOf(Uri uri) {
        if (uri.getScheme() == null || uri.getHost() == null) return "";
        String origin = uri.getScheme().toLowerCase(Locale.ROOT) + "://" + uri.getHost().toLowerCase(Locale.ROOT);
        return uri.getPort() == -1 ? origin : origin + ":" + uri.getPort();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private int color(int id) {
        return getColor(id);
    }

    private int attribute(int attr) {
        TypedValue value = new TypedValue();
        getTheme().resolveAttribute(attr, value, true);
        return value.resourceId;
    }

    private void toast(String text) {
        if (!TextUtils.isEmpty(text)) Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }
}
