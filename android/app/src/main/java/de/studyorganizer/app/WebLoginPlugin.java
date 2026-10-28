package de.studyorganizer.app;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen in-app browser for university logins (see src/renderer/src/mobile/web-login.ts).
 *
 * The call finishes in one of three ways:
 * - the page navigates to an address starting with "interceptPrefix" (Moodle SSO token redirect),
 * - the user taps "Fertig" after downloads were captured (TUCaN calendar export),
 * - the user closes the browser, which rejects the call.
 */
@CapacitorPlugin(name = "WebLogin")
public class WebLoginPlugin extends Plugin {

    /** Calendar exports are small; anything bigger is not what we are looking for */
    private static final int MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

    private final ExecutorService downloads = Executors.newSingleThreadExecutor();
    private final Handler mainThread = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("Ungültige Adresse");
            return;
        }
        getActivity().runOnUiThread(() -> new Session(call, url).show());
    }

    /** One open browser window and the call it will answer */
    private class Session {
        private final PluginCall call;
        private final String startUrl;
        private final String interceptPrefix;
        private final boolean captureDownloads;
        private final List<JSObject> captured = new ArrayList<>();
        private Dialog dialog;
        private WebView webView;
        private Button doneButton;
        private boolean finished = false;

        Session(PluginCall call, String startUrl) {
            this.call = call;
            this.startUrl = startUrl;
            this.interceptPrefix = call.getString("interceptPrefix");
            this.captureDownloads = Boolean.TRUE.equals(call.getBoolean("captureDownloads", false));
        }

        @SuppressLint("SetJavaScriptEnabled")
        void show() {
            dialog = new Dialog(getActivity(), android.R.style.Theme_DeviceDefault_Light_NoActionBar);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);

            LinearLayout root = new LinearLayout(getContext());
            root.setOrientation(LinearLayout.VERTICAL);
            root.setBackgroundColor(Color.WHITE);
            root.addView(createToolbar());
            String hint = call.getString("hint");
            if (hint != null && !hint.isEmpty()) root.addView(createHint(hint));

            webView = new WebView(getContext());
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setSupportMultipleWindows(false);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
            webView.setWebViewClient(new LoginClient());
            webView.setDownloadListener((downloadUrl, userAgent, contentDisposition, mimeType, length) ->
                    onDownload(downloadUrl, userAgent, contentDisposition, mimeType));
            root.addView(webView, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

            dialog.setContentView(root);
            dialog.setOnDismissListener(d -> finishCancelled());
            dialog.setOnKeyListener((d, keyCode, event) -> {
                // The back button navigates inside the login pages before it closes the browser
                if (keyCode == android.view.KeyEvent.KEYCODE_BACK
                        && event.getAction() == android.view.KeyEvent.ACTION_UP
                        && webView.canGoBack()) {
                    webView.goBack();
                    return true;
                }
                return false;
            });
            dialog.show();
            webView.loadUrl(startUrl);
        }

        private LinearLayout createToolbar() {
            LinearLayout bar = new LinearLayout(getContext());
            bar.setOrientation(LinearLayout.HORIZONTAL);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            int padding = dp(8);
            bar.setPadding(padding, padding, padding, padding);

            Button close = new Button(getContext());
            close.setText("Abbrechen");
            close.setOnClickListener(v -> dialog.dismiss());
            bar.addView(close);

            TextView title = new TextView(getContext());
            title.setText(call.getString("title", ""));
            title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            title.setTextColor(Color.BLACK);
            title.setGravity(Gravity.CENTER);
            bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

            doneButton = new Button(getContext());
            doneButton.setText("Fertig");
            doneButton.setEnabled(false);
            doneButton.setOnClickListener(v -> finishWithDownloads());
            if (!captureDownloads) doneButton.setVisibility(android.view.View.INVISIBLE);
            bar.addView(doneButton);
            return bar;
        }

        private TextView createHint(String text) {
            TextView hint = new TextView(getContext());
            hint.setText(text);
            hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            hint.setTextColor(Color.DKGRAY);
            hint.setBackgroundColor(Color.rgb(240, 240, 245));
            hint.setPadding(dp(16), dp(10), dp(16), dp(10));
            return hint;
        }

        private int dp(int value) {
            return Math.round(value * getContext().getResources().getDisplayMetrics().density);
        }

        /** True if the address ends the login; consumes it */
        private boolean intercept(String url) {
            if (interceptPrefix != null && url.startsWith(interceptPrefix)) {
                JSObject result = new JSObject();
                result.put("redirectUrl", url);
                result.put("downloads", new JSArray());
                finish(result);
                return true;
            }
            return false;
        }

        private class LoginClient extends WebViewClient {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (intercept(url)) return true;
                // Never hand other schemes (intent://, market:// …) to other apps
                String scheme = request.getUrl().getScheme();
                return !"https".equals(scheme) && !"http".equals(scheme);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceError error) {
                // Some pages redirect to the custom scheme in a way that only shows up as an error
                if (request.isForMainFrame()) intercept(request.getUrl().toString());
            }
        }

        private void onDownload(String url, String userAgent, String contentDisposition, String mimeType) {
            if (!captureDownloads) return;
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                Toast.makeText(getContext(), "Dieser Download kann nicht übernommen werden.",
                        Toast.LENGTH_LONG).show();
                return;
            }
            downloads.execute(() -> {
                try {
                    byte[] bytes = fetchWithSessionCookies(url, userAgent);
                    JSObject file = new JSObject();
                    file.put("fileName", fileName);
                    file.put("mimeType", mimeType == null ? "" : mimeType);
                    file.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    mainThread.post(() -> onCaptured(file));
                } catch (IOException e) {
                    mainThread.post(() -> Toast.makeText(getContext(),
                            "Download fehlgeschlagen: " + e.getMessage(), Toast.LENGTH_LONG).show());
                }
            });
        }

        private void onCaptured(JSObject file) {
            if (finished) return;
            captured.add(file);
            doneButton.setEnabled(true);
            doneButton.setText("Fertig (" + captured.size() + ")");
            Toast.makeText(getContext(), "Übernommen: " + file.getString("fileName"),
                    Toast.LENGTH_SHORT).show();
        }

        private void finishWithDownloads() {
            JSArray files = new JSArray();
            for (JSObject file : captured) files.put(file);
            JSObject result = new JSObject();
            result.put("downloads", files);
            finish(result);
        }

        private void finish(JSObject result) {
            if (finished) return;
            finished = true;
            call.resolve(result);
            closeDialog();
        }

        private void finishCancelled() {
            if (finished) return;
            finished = true;
            call.reject("Anmeldung abgebrochen.");
            closeDialog();
        }

        private void closeDialog() {
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
            if (webView != null) webView.destroy();
        }
    }

    /** Downloads a file with the cookies of the login session */
    private static byte[] fetchWithSessionCookies(String url, String userAgent) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) connection.setRequestProperty("Cookie", cookies);
            if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
            connection.setInstanceFollowRedirects(true);
            if (connection.getResponseCode() >= 400) {
                throw new IOException("HTTP " + connection.getResponseCode());
            }
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (out.size() + read > MAX_DOWNLOAD_BYTES) throw new IOException("Datei zu groß");
                    out.write(buffer, 0, read);
                }
                return out.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }
}
