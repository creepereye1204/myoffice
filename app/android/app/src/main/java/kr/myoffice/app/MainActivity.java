package kr.myoffice.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 알오피스 안드로이드 — assets/www 의 앱 화면을 WebView 로 띄운다. 인터넷 없이 기기 안에서만.
 *  - https://appassets.androidplatform.net/ 요청을 가로채 assets/www 파일로 답한다 (다른 주소는 막음).
 *  - window.AndroidBridge: 파일 열기/저장(저장소 접근 프레임워크), "다음 앱으로 열기"로 받은 문서 넘기기.
 *    결과는 window.__bridgeDone(id, json) 으로 돌려준다. 읽은 파일 내용은 /__file/<토큰> 주소로 받아 가게 해서
 *    큰 문서도 문자열로 바꾸지 않는다. 쓰기는 base64 문자열로 받는다.
 */
public class MainActivity extends Activity {
    static final String TAG = "MyOffice";
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final int REQ_OPEN = 1, REQ_SAVE = 2;
    static final Map<String, String> MIME = new HashMap<>();
    static {
        String[][] m = {
            {"html", "text/html"}, {"js", "text/javascript"}, {"mjs", "text/javascript"}, {"css", "text/css"},
            {"json", "application/json"}, {"webmanifest", "application/manifest+json"}, {"map", "application/json"},
            {"svg", "image/svg+xml"}, {"png", "image/png"}, {"jpg", "image/jpeg"}, {"jpeg", "image/jpeg"}, {"gif", "image/gif"},
            {"ico", "image/x-icon"}, {"webp", "image/webp"}, {"wasm", "application/wasm"}, {"ttf", "font/ttf"}, {"otf", "font/otf"},
            {"woff", "font/woff"}, {"woff2", "font/woff2"}, {"txt", "text/plain"}, {"xml", "application/xml"}, {"pdf", "application/pdf"},
        };
        for (String[] e : m) MIME.put(e[0], e[1]);
    }
    static final Map<String, String> DOC_MIME = new HashMap<>();
    static {
        String[][] m = {
            {"hwp", "application/x-hwp"}, {"hwpx", "application/hwp+zip"},
            {"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
            {"xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
            {"pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
            {"csv", "text/csv"}, {"pdf", "application/pdf"},
        };
        for (String[] e : m) DOC_MIME.put(e[0], e[1]);
    }

    WebView web;
    final Handler ui = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newSingleThreadExecutor();
    final Map<String, byte[]> served = new HashMap<>();   // /__file/<토큰> → 문서 내용 (한 번 받아 가면 지움)
    boolean jsReady = false, dirty = false;
    Uri pendingOpen;
    int pickId;                 // 진행 중인 열기/저장 대화상자 요청 id
    String pendingSaveData;     // 저장 대화상자에서 고른 곳에 쓸 내용

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
            || "1".equals(System.getProperty("myoffice.debug")));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f6f7f9"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        // 새 창(window.open)은 받지 않는다 — 꺼 두면 WebView 가 앱 화면 자리에 그 페이지를 띄워 버린다
        s.setSupportMultipleWindows(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView v, boolean dialog, boolean userGesture, android.os.Message msg) {
                return false;
            }
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return serve(req.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) {
                    // 앱 화면(/myoffice/) 밖으로 큰 창이 이동하지 않게 (편집기 iframe 안 이동은 그대로)
                    String p = u.getPath() == null ? "" : u.getPath();
                    return req.isForMainFrame() && !p.startsWith("/myoffice/");
                }
                // 바깥 링크(도움말 등)는 브라우저로
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }
        });
        setContentView(web);
        web.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        handleIntent(getIntent());
        web.loadUrl(ORIGIN + "/myoffice/index.html");
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    void handleIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        String a = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(a) && !Intent.ACTION_EDIT.equals(a)) return;
        Uri uri = intent.getData();
        takePermission(uri, intent.getFlags());
        if (jsReady) deliverOpen(uri); else pendingOpen = uri;
    }

    void deliverOpen(Uri uri) {
        io.execute(() -> {
            try {
                JSONObject r = readDoc(uri);
                js("window.__openRequest(" + JSONObject.quote(r.toString()) + ")");
            } catch (Exception e) {
                Log.e(TAG, "open", e);
                ui.post(() -> Toast.makeText(this, "열 수 없습니다: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        });
    }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.__onBack ? window.__onBack() : false", v -> {
            if (!"true".equals(v)) super.onBackPressed();
        });
    }

    // ------------------------------------------------------------ 앱 파일 내주기
    WebResourceResponse serve(Uri u) {
        if (!HOST.equals(u.getHost())) return text(403, "blocked");   // 인터넷으로 나가지 않음
        String path = u.getPath() == null ? "/" : u.getPath();
        Map<String, String> h = new HashMap<>();
        h.put("Cross-Origin-Opener-Policy", "same-origin");
        h.put("Cross-Origin-Embedder-Policy", "require-corp");
        h.put("Cross-Origin-Resource-Policy", "same-origin");
        h.put("Cache-Control", "no-cache");
        if (path.startsWith("/__file/")) {
            byte[] b;
            synchronized (served) { b = served.remove(path.substring(8)); }
            if (b == null) return text(404, "gone");
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", h, new ByteArrayInputStream(b));
        }
        if (path.equals("/")) path = "/myoffice/index.html";
        AssetManager am = getAssets();
        String base = "www" + path.replaceAll("/+$", "");
        for (String c : new String[]{base, base + "/index.html", base + ".html"}) {
            if (c.contains("..")) break;
            try {
                InputStream in = am.open(c, AssetManager.ACCESS_STREAMING);
                String ext = c.substring(c.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                String mime = c.endsWith("x2t.wasm.br") ? "application/wasm" : MIME.getOrDefault(ext, "application/octet-stream");
                String enc = mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json") ? "utf-8" : null;
                return new WebResourceResponse(mime, enc, 200, "OK", h, in);
            } catch (FileNotFoundException ignored) {
            } catch (IOException e) {
                Log.w(TAG, "asset " + c, e);
            }
        }
        return text(404, "not found");
    }

    static WebResourceResponse text(int code, String msg) {
        Map<String, String> h = new HashMap<>();
        h.put("Cross-Origin-Resource-Policy", "same-origin");
        return new WebResourceResponse("text/plain", "utf-8", code, code == 404 ? "Not Found" : "Forbidden", h,
            new ByteArrayInputStream(msg.getBytes()));
    }

    // ------------------------------------------------------------ 파일
    void takePermission(Uri uri, int flags) {
        try {
            int f = flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0 && f != 0) getContentResolver().takePersistableUriPermission(uri, f);
        } catch (SecurityException ignored) { }
    }

    String nameOf(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) { String n = c.getString(0); if (n != null) return n; }
        } catch (Exception ignored) { }
        String p = uri.getLastPathSegment();
        return p == null ? "문서" : p.substring(p.lastIndexOf('/') + 1);
    }

    JSONObject readDoc(Uri uri) throws IOException, JSONException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("읽을 수 없음");
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
        String token = UUID.randomUUID().toString();
        synchronized (served) { served.put(token, out.toByteArray()); }
        return new JSONObject().put("handle", uri.toString()).put("name", nameOf(uri)).put("url", "/__file/" + token);
    }

    void writeDoc(Uri uri, String b64) throws IOException {
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        ContentResolver cr = getContentResolver();
        OutputStream os;
        try { os = cr.openOutputStream(uri, "wt"); } catch (Exception e) { os = cr.openOutputStream(uri, "w"); }
        if (os == null) throw new IOException("쓸 수 없음");
        try (OutputStream o = os) { o.write(data); }
    }

    void js(String code) { ui.post(() -> web.evaluateJavascript(code, null)); }
    void done(int id, JSONObject r) { js("window.__bridgeDone(" + id + "," + JSONObject.quote(r.toString()) + ")"); }
    void fail(int id, Exception e) {
        Log.w(TAG, "bridge", e);
        try { done(id, new JSONObject().put("error", e.getMessage() == null ? e.toString() : e.getMessage())); } catch (JSONException ignored) { }
    }
    void cancel(int id) { js("window.__bridgeDone(" + id + ",'null')"); }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        int id = pickId;
        Uri uri = res == RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) { pendingSaveData = null; cancel(id); return; }
        takePermission(uri, data.getFlags() | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        if (req == REQ_OPEN) {
            io.execute(() -> { try { done(id, readDoc(uri)); } catch (Exception e) { fail(id, e); } });
        } else if (req == REQ_SAVE) {
            String b64 = pendingSaveData;
            pendingSaveData = null;
            io.execute(() -> {
                try {
                    writeDoc(uri, b64);
                    done(id, new JSONObject().put("handle", uri.toString()).put("name", nameOf(uri)));
                } catch (Exception e) { fail(id, e); }
            });
        }
    }

    class Bridge {
        @JavascriptInterface public void pickOpen(int id) {
            ui.post(() -> {
                pickId = id;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                try { startActivityForResult(i, REQ_OPEN); } catch (ActivityNotFoundException e) { fail(id, e); }
            });
        }
        @JavascriptInterface public void read(int id, String handle) {
            io.execute(() -> { try { done(id, readDoc(Uri.parse(handle))); } catch (Exception e) { fail(id, e); } });
        }
        @JavascriptInterface public void write(int id, String handle, String b64) {
            io.execute(() -> { try { writeDoc(Uri.parse(handle), b64); done(id, new JSONObject().put("ok", true)); } catch (Exception e) { fail(id, e); } });
        }
        @JavascriptInterface public void pickSave(int id, String name, String b64) {
            ui.post(() -> {
                pickId = id;
                pendingSaveData = b64;
                String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(DOC_MIME.getOrDefault(ext, "application/octet-stream")).putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); } catch (ActivityNotFoundException e) { pendingSaveData = null; fail(id, e); }
            });
        }
        @JavascriptInterface public void ready() {
            ui.post(() -> {
                jsReady = true;
                if (pendingOpen != null) { Uri u = pendingOpen; pendingOpen = null; deliverOpen(u); }
            });
        }
        @JavascriptInterface public void setDirty(boolean d) { dirty = d; }
    }
}
