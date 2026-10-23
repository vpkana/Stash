package app.web.Stash;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * The installed-app half of Google sign-in.
 *
 * Android's WebView cannot call Google's token endpoint directly: the request
 * carries no browser origin Google accepts, and the response has no CORS headers.
 * This bridge performs the two form posts of the OAuth code flow — exchange and
 * revoke — as ordinary native HTTPS requests, and hands the raw status and body
 * back to JavaScript, which owns the protocol decisions.
 *
 * ## What it deliberately cannot do
 *
 * The URL is checked against a fixed allow-list. Without that, a compromised web
 * layer could use the bridge as an authenticated-free HTTP client and reach any
 * host from the device. The body is a form post, never logged, never persisted,
 * and never included in an error message; a refresh token passes through this
 * method twice in the life of an install and is stored only in the
 * Keystore-backed secure store by the caller.
 *
 * No client secret exists on either platform. The authorization code is bound to
 * a PKCE verifier generated in JavaScript, so an intercepted redirect cannot be
 * exchanged by anyone else.
 */
@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {

    private static final Set<String> ALLOWED_ENDPOINTS = new HashSet<>(Arrays.asList(
        "https://oauth2.googleapis.com/token",
        "https://oauth2.googleapis.com/revoke"
    ));

    private static final int CONNECT_TIMEOUT_MS = 20_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final int MAX_REQUEST_BYTES = 16 * 1024;
    private static final int MAX_RESPONSE_CHARS = 64 * 1024;

    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url");
        String body = call.getString("body");
        if (url == null || body == null) {
            call.reject("invalid-request");
            return;
        }
        if (!ALLOWED_ENDPOINTS.contains(url)) {
            call.reject("unsupported-endpoint");
            return;
        }
        if (body.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            call.reject("request-too-large");
            return;
        }

        // HttpURLConnection blocks; the JS caller is already awaiting a promise,
        // so this must not run on whatever thread delivered the plugin call.
        Thread worker = new Thread(() -> perform(call, url, body), "stash-google-auth");
        worker.setDaemon(true);
        worker.start();
    }

    private void perform(PluginCall call, String url, String body) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            connection.setRequestProperty("Accept", "application/json");

            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String responseBody = read(stream);

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", responseBody);
            call.resolve(result);
        } catch (Exception failure) {
            // Deliberately generic: the exception text can name a host, and the
            // body it was posting is never safe to echo.
            call.reject("network");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8)
        )) {
            char[] chunk = new char[4096];
            int read;
            while ((read = reader.read(chunk)) >= 0) {
                if (builder.length() + read > MAX_RESPONSE_CHARS) {
                    builder.append(chunk, 0, Math.max(0, MAX_RESPONSE_CHARS - builder.length()));
                    break;
                }
                builder.append(chunk, 0, read);
            }
        }
        return builder.toString();
    }
}
