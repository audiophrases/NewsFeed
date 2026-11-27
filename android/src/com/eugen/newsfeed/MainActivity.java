package com.eugen.newsfeed;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
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
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
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
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.SequenceInputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.net.ssl.SSLException;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * NewsFeed on the phone, with no server. The app carries NewsFeed's page (the web app's own files,
 * put in by build.ps1) and serves it from inside itself at APP_ORIGIN. On the web a server has to
 * fetch feeds and articles for the page, because a web page can't read other sites; here the app
 * does it for the page (/app/net), as the phone, so the server's API (lib/api.js) runs in the page
 * itself (public/local.js). Sites that turn servers away (Google News' article links, outlets
 * behind Cloudflare's bot check) usually let a phone in.
 *
 * Some pages need a browser all the same (a check that runs scripts, a page filled in by them):
 * when NewsFeed asks, the app opens an article in a browser view of its own, the way Chrome would
 * (Google News forwards it to the outlet), and hands the page back to NewsFeed, which shows it in
 * its reader. When something is in the way (a cookie choice, a check), the page is shown: tap
 * through it, then Reading mode.
 *
 * NewsFeed's page and the app talk through a message channel the app gives that page only (not to
 * frames in it, nor to any other site). Messages are JSON:
 *   page -> app: read {id, url}, show {id, hint}, hide {id}, cancel {id}, toast {text},
 *                save {name, text, mime}
 *   app -> page: address {id, url}, page {id, url, title, html, user, challenge}, stuck {id, reason},
 *                failed {id, error}, closed {id}
 */
public class MainActivity extends Activity {

    /**
     * Where the app serves NewsFeed's page from: Android's address for an app's own files (a real
     * https address, so the page keeps what you follow and read as on any site; nothing is fetched).
     */
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    /** What the app sends NewsFeed's page with the channel's port: the bridge's name and version. */
    private static final String HELLO = "newsfeed-android:1";
    /** Fetching for the page, as NewsFeed's server does: how long to wait, how far to be sent on. */
    private static final int TIMEOUT_MS = 15000;
    private static final int MAX_REDIRECTS = 5;
    /** The response headers the page's API looks at. */
    private static final String[] PASSED_HEADERS = {
        "content-type", "location", "x-frame-options", "content-security-policy", "cf-mitigated",
    };
    /** What the page kept, read where it was kept before (the app showed NewsFeed from its server). */
    private static final String COLLECT_JS = "(function () {\n"
            + "  var kept = {};\n"
            + "  for (var i = 0; i < localStorage.length; i++) {\n"
            + "    var key = localStorage.key(i);\n"
            + "    if (key.indexOf('newsfeed.') === 0) kept[key] = localStorage.getItem(key);\n"
            + "  }\n"
            + "  return kept;\n"
            + "})()";
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
    /** Opened afresh (not restored): what came before it in the view's history goes. */
    private boolean clearHistory;
    /** Asked for with every fetch: only NewsFeed's own page knows it (it's new each time the app starts). */
    private String token;
    /** Fetches go as the phone's browser view (whose cookies they share). */
    private String userAgent;

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
        appUri = Uri.parse(APP_ORIGIN + "/");
        appOrigin = APP_ORIGIN;
        byte[] secret = new byte[24];
        new SecureRandom().nextBytes(secret);
        StringBuilder hex = new StringBuilder();
        for (byte b : secret) hex.append(String.format(Locale.ROOT, "%02x", b));
        token = hex.toString();
        userAgent = WebSettings.getDefaultUserAgent(this);
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
        // Back where it was (the page as you left it), unless that was NewsFeed from its server.
        WebBackForwardList restored = state == null ? null : main.restoreState(state);
        if (restored == null || restored.getCurrentItem() == null
                || !appOrigin.equals(originOf(Uri.parse(restored.getCurrentItem().getUrl())))) {
            moveOldDataThenOpen();
        }
    }

    private void open() {
        clearHistory = true;
        main.loadUrl(appUri.toString());
    }

    /**
     * Before the app carried NewsFeed's page, it showed it from NewsFeed's server (moved_from),
     * and what you follow, read and saved was kept under that address. Once, it's read from there
     * (the old address is answered by the app, so nothing is fetched) for NewsFeed's page to take
     * over (/app/config.json), and then NewsFeed opens.
     */
    private void moveOldDataThenOpen() {
        SharedPreferences prefs = getSharedPreferences("newsfeed", MODE_PRIVATE);
        Uri from = Uri.parse(getString(R.string.moved_from));
        String oldOrigin = originOf(from);
        if (prefs.getBoolean("looked-for-old-data", false) || oldOrigin.isEmpty()) {
            open();
            return;
        }
        WebView mover = new WebView(this);
        mover.getSettings().setJavaScriptEnabled(true);
        mover.getSettings().setDomStorageEnabled(true);
        boolean[] done = { false };
        Runnable finish = () -> {
            if (done[0]) return;
            done[0] = true;
            root.removeView(mover);
            mover.destroy();
            open();
        };
        mover.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request.isForMainFrame() && oldOrigin.equals(originOf(request.getUrl()))) {
                    return text(200, "text/html", "<!doctype html><title>NewsFeed</title>");
                }
                return text(404, "text/plain", "");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (done[0] || !oldOrigin.equals(originOf(Uri.parse(url)))) return;
                view.evaluateJavascript(COLLECT_JS, value -> {
                    if (done[0]) return;
                    try {
                        JSONObject kept = new JSONObject(value);
                        if (kept.length() > 0) {
                            try (OutputStream out = new FileOutputStream(movedFile())) {
                                out.write(kept.toString().getBytes(StandardCharsets.UTF_8));
                            }
                        }
                        prefs.edit().putBoolean("looked-for-old-data", true).apply();
                    } catch (JSONException | IOException e) {
                        // Looked for again next time.
                    }
                    finish.run();
                });
            }
        });
        root.addView(mover, 0, new FrameLayout.LayoutParams(1, 1));
        mover.loadUrl(oldOrigin + "/");
        ui.postDelayed(finish, 5000);
    }

    /** What the app kept to hand to NewsFeed's page, until the page has it. */
    private File movedFile() {
        return new File(getFilesDir(), "moved.json");
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
        /** NewsFeed's own address is answered by the app (on a background thread): see appResponse. */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return appOrigin.equals(originOf(request.getUrl())) ? appResponse(request) : null;
        }

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
            if (!appOrigin.equals(originOf(Uri.parse(url)))) return;
            if (clearHistory) {
                clearHistory = false;
                main.clearHistory();
            }
            connect();
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

    // ---- NewsFeed's own address: its files, and fetching for it --------------------------------

    /**
     * A request to NewsFeed's own address: a file of its page (assets/www, put in by build.ps1),
     * or one of the app's answers under /app/: the page's settings, a fetch, word that the page
     * has what the app kept for it.
     */
    private WebResourceResponse appResponse(WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = TextUtils.isEmpty(url.getPath()) ? "/" : url.getPath();
        switch (path) {
            case "/app/config.json":
                return config();
            case "/app/net":
                return fromPage(request) ? fetchFor(url) : text(403, "text/plain", "Not NewsFeed's request");
            case "/app/moved":
                if (!fromPage(request)) return text(403, "text/plain", "Not NewsFeed's request");
                //noinspection ResultOfMethodCallIgnored
                movedFile().delete();
                return text(200, "text/plain", "ok");
            default:
                break;
        }
        if (path.equals("/")) path = "/index.html";
        if (path.contains("..") || path.startsWith("/app/")) return text(404, "text/plain", "Not found");
        try {
            InputStream in = getAssets().open("www" + path);
            String type = typeOf(path);
            boolean textual = type.startsWith("text/") || type.endsWith("json") || type.endsWith("xml");
            return new WebResourceResponse(type, textual ? "utf-8" : null, 200, "OK", noStore(), in);
        } catch (IOException e) {
            return text(404, "text/plain", "Not found");
        }
    }

    /** The page's settings: the word its fetches carry, the sync service, and what the app kept for it. */
    private WebResourceResponse config() {
        JSONObject config = new JSONObject();
        try {
            config.put("token", token);
            config.put("syncUrl", getString(R.string.sync_url));
            File moved = movedFile();
            if (moved.exists()) {
                byte[] bytes = new byte[(int) moved.length()];
                try (InputStream in = new FileInputStream(moved)) {
                    int at = 0;
                    for (int n; at < bytes.length && (n = in.read(bytes, at, bytes.length - at)) > 0; ) at += n;
                }
                config.put("moved", new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
            }
        } catch (JSONException | IOException e) {
            // Without what was kept, then.
        }
        return text(200, "application/json", config.toString());
    }

    /** Whether a request comes from NewsFeed's own page (it carries the app's word), not a frame in it. */
    private boolean fromPage(WebResourceRequest request) {
        for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
            if ("X-NewsFeed".equalsIgnoreCase(header.getKey())) return token.equals(header.getValue());
        }
        return false;
    }

    /**
     * Fetches what the page asks for (url, method, body, headers as JSON, max bytes, follow
     * redirects or not), as NewsFeed's server would. The answer is a line of JSON (status, address
     * after redirects, the headers that matter, or the error) and then the response's bytes. The
     * fetch starts when the page reads the answer, on WebView's background thread, not here.
     */
    private WebResourceResponse fetchFor(Uri ask) {
        InputStream answer = new InputStream() {
            private InputStream in;

            private InputStream in() {
                if (in == null) in = download(ask);
                return in;
            }

            @Override
            public int read() throws IOException {
                return in().read();
            }

            @Override
            public int read(byte[] b, int off, int len) throws IOException {
                return in().read(b, off, len);
            }

            @Override
            public void close() throws IOException {
                if (in != null) in.close();
            }
        };
        return new WebResourceResponse("application/octet-stream", null, 200, "OK", noStore(), answer);
    }

    private InputStream download(Uri ask) {
        String current = ask.getQueryParameter("url");
        String method = "POST".equals(ask.getQueryParameter("method")) ? "POST" : "GET";
        String body = ask.getQueryParameter("body");
        boolean follow = !"0".equals(ask.getQueryParameter("follow"));
        long max;
        try {
            max = Long.parseLong(ask.getQueryParameter("max"));
        } catch (NumberFormatException e) {
            max = 8L * 1024 * 1024;
        }
        try {
            JSONObject headers = new JSONObject(ask.getQueryParameter("headers") == null ? "{}" : ask.getQueryParameter("headers"));
            for (int hop = 0; ; hop++) {
                URL target = new URL(current);
                if (!target.getProtocol().equals("http") && !target.getProtocol().equals("https")) {
                    return answer(failure("Not a web address", current), null);
                }
                // As NewsFeed's server: links never lead into the network the phone is on.
                for (InetAddress address : InetAddress.getAllByName(target.getHost())) {
                    if (isPrivate(address)) return answer(failure("Address is on a private network", current), null);
                }
                HttpURLConnection connection = (HttpURLConnection) target.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(TIMEOUT_MS);
                connection.setReadTimeout(TIMEOUT_MS);
                connection.setRequestMethod(method);
                connection.setRequestProperty("User-Agent", userAgent);
                for (Iterator<String> names = headers.keys(); names.hasNext(); ) {
                    String name = names.next();
                    connection.setRequestProperty(name, headers.getString(name));
                }
                String cookies = CookieManager.getInstance().getCookie(current);
                if (!TextUtils.isEmpty(cookies)) connection.setRequestProperty("Cookie", cookies);
                if (body != null) {
                    connection.setDoOutput(true);
                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = connection.getResponseCode();
                keepCookies(connection, current);
                String location = connection.getHeaderField("Location");
                if (follow && status >= 300 && status < 400 && location != null) {
                    connection.disconnect();
                    if (hop >= MAX_REDIRECTS) return answer(failure("Too many redirects", current), null);
                    current = new URL(target, location).toString();
                    continue;
                }
                JSONObject passed = new JSONObject();
                for (String name : PASSED_HEADERS) {
                    String value = connection.getHeaderField(name);
                    if (value != null) passed.put(name, value);
                }
                JSONObject meta = new JSONObject().put("status", status).put("url", current).put("headers", passed);
                if (status < 200 || status >= 300) {
                    connection.disconnect();
                    return answer(meta, null);
                }
                return answer(meta, new Capped(connection.getInputStream(), max, connection));
            }
        } catch (SocketTimeoutException e) {
            JSONObject failed = failure("Timed out", current);
            try {
                failed.put("timeout", true);
            } catch (JSONException ignored) {
                // still a failure
            }
            return answer(failed, null);
        } catch (UnknownHostException e) {
            return answer(failure("fetch failed (host not found)", current), null);
        } catch (SSLException e) {
            return answer(failure("fetch failed (secure connection failed)", current), null);
        } catch (IOException | JSONException | RuntimeException e) {
            return answer(failure("fetch failed (" + e.getClass().getSimpleName() + ")", current), null);
        }
    }

    private static JSONObject failure(String error, String url) {
        try {
            return new JSONObject().put("error", error).put("url", url == null ? JSONObject.NULL : url);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The answer to the page: its line of JSON, then the response's bytes (if any). */
    private static InputStream answer(JSONObject meta, InputStream body) {
        InputStream head = new ByteArrayInputStream((meta.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        return body == null ? head : new SequenceInputStream(head, body);
    }

    /** Cookies a site sets are kept, as the phone's browser view keeps them (and sends them back). */
    private static void keepCookies(HttpURLConnection connection, String url) {
        for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
            if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Set-Cookie")) continue;
            for (String cookie : header.getValue()) CookieManager.getInstance().setCookie(url, cookie);
        }
    }

    /** An address on this phone or the network it's on (as lib/fetch.js's isPrivateAddress). */
    private static boolean isPrivate(InetAddress address) {
        if (address.isLoopbackAddress() || address.isAnyLocalAddress() || address.isLinkLocalAddress()
                || address.isSiteLocalAddress() || address.isMulticastAddress()) return true;
        byte[] b = address.getAddress();
        if (address instanceof Inet4Address) return (b[0] & 0xff) == 100 && (b[1] & 0xc0) == 64; // 100.64.0.0/10
        return address instanceof Inet6Address && (b[0] & 0xfe) == 0xfc; // fc00::/7
    }

    /** A response's body, at most max bytes of it; closing it ends the connection. */
    private static final class Capped extends FilterInputStream {
        private long left;
        private final HttpURLConnection connection;

        Capped(InputStream in, long max, HttpURLConnection connection) {
            super(in);
            this.left = max;
            this.connection = connection;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                connection.disconnect();
            }
        }
    }

    private static Map<String, String> noStore() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return headers;
    }

    private static WebResourceResponse text(int status, String type, String body) {
        return new WebResourceResponse(type, "utf-8", status, status == 200 ? "OK" : status == 403 ? "Forbidden" : "Not Found",
                noStore(), new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static String typeOf(String path) {
        String name = path.toLowerCase(Locale.ROOT);
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".webmanifest")) return "application/manifest+json";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".md")) return "text/markdown";
        return "application/octet-stream";
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
