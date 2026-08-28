package com.shafiqadwh.weddingslideshow;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * จอสไลด์โชว์สำหรับ Google TV — เปิดแล้วขึ้นเลย ไม่มีหน้าล็อกอิน ไม่มีแถบที่อยู่
 * ไม่ต้องพิมพ์อะไรด้วยรีโมตในวันงาน
 *
 * ทั้งแอปคือ WebView ที่ชี้ไปหน้า /slideshow ของเซิร์ฟเวอร์เดียวกับที่แขกใช้
 * สไลด์โชว์จึงไม่มีโค้ดซ้ำสองชุด แก้ที่เว็บที่เดียวแล้วทีวีได้ตามทันที
 */
public class SlideshowActivity extends Activity {

    private static final String PREFS = "wedding-slideshow";
    private static final String KEY_URL = "url";

    /** หน่วงก่อนลองใหม่ เพิ่มขึ้นเรื่อย ๆ แต่ไม่เกินครึ่งนาที */
    private static final long RETRY_START_MS = 2000;
    private static final long RETRY_MAX_MS = 30000;

    /**
     * ที่อยู่ที่เคยใช้ได้แล้วล้มติดกันกี่ครั้ง ถึงจะยอมสลับไปที่อยู่อื่น
     *
     * ต้องมากกว่า 1 เพื่อไม่ให้เน็ตสะดุดแวบเดียวกลางงานพาเราหนีจากที่อยู่ที่ใช้ได้ดีอยู่
     * แต่ต้องไม่มากจนติดแหง็กอยู่กับที่อยู่ที่ตายไปแล้วจริง ๆ
     */
    private static final int FAILS_BEFORE_SWITCH = 2;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView web;
    private TextView status;
    private List<String> urls = new ArrayList<>();
    private int urlIndex = 0;
    private long retryDelay = RETRY_START_MS;
    /** ที่อยู่ตัวที่กำลังใช้อยู่ เคยโหลดขึ้นจริงแล้วอย่างน้อยหนึ่งครั้งไหม */
    private boolean loaded = false;
    /** รอบการโหลดรอบนี้ล้มไปแล้วหรือยัง — รีเซ็ตทุกครั้งที่เริ่มโหลดใหม่ */
    private boolean attemptFailed = false;
    private int failStreak = 0;
    private String lastError = null;
    private long lastBackPress = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // จอต้องไม่ดับตลอดงาน สไลด์โชว์ไม่มีใครแตะรีโมตเป็นชั่วโมง ๆ
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        configureWeb(web);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // ข้อความบอกสถานะ ระหว่างที่ยังต่อไม่ติด จอดำเปล่า ๆ ทำให้คนคิดว่าแอปพัง
        status = new TextView(this);
        status.setTextColor(Color.parseColor("#E8C98A"));
        status.setTextSize(20);
        status.setGravity(Gravity.CENTER);
        status.setText(getString(R.string.connecting) + "\n\n" + getString(R.string.settings_hint_line));
        FrameLayout.LayoutParams statusParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        statusParams.gravity = Gravity.CENTER;
        root.addView(status, statusParams);

        setContentView(root);

        buildUrlList();
        load();
    }

    private void configureWeb(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        // สำคัญที่สุดข้อเดียวของไฟล์นี้ — ถ้าไม่ตั้ง วิดีโอในสไลด์โชว์จะไม่เล่นเอง
        // เพราะเบราว์เซอร์รอ "การแตะจากผู้ใช้" ซึ่งบนทีวีไม่มีวันเกิดขึ้น
        settings.setMediaPlaybackRequiresUserGesture(false);

        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);

        view.setWebViewClient(new WebViewClient() {
            /**
             * ⚠️ กับดักที่เคยทำให้แอปใช้ไม่ได้ทั้งงานตอนต่อ 5G
             *
             * WebView เรียก onPageFinished **สำหรับหน้า error ของตัวเองด้วย** — โหลดไม่ขึ้น
             * มันก็วาดหน้า "เว็บนี้ใช้ไม่ได้" แล้วบอกเราว่า "โหลดเสร็จแล้ว" เหมือนกันเป๊ะ
             *
             * เดิมตรงนี้ตั้ง loaded = true ทันทีโดยไม่แยกสองกรณี พอที่อยู่แรกล้มแวบเดียว
             * แอปสลับไปที่อยู่สำรอง (ไอพีในวง LAN) แล้วหน้า error ก็ทำให้ loaded = true
             * ค้างถาวร — scheduleRetry() จึงไม่ยอมสลับที่อยู่อีกเลย ทีวีที่ต่อ 5G เลยติดแหง็ก
             * อยู่กับ 192.168.2.2 ซึ่งไม่มีทางต่อติดจากนอกบ้าน จนกว่าจะบังคับปิดแอปเปิดใหม่
             */
            @Override
            public void onPageFinished(WebView v, String url) {
                if (attemptFailed || "about:blank".equals(url)) return;

                loaded = true;
                failStreak = 0;
                lastError = null;
                retryDelay = RETRY_START_MS;
                status.setVisibility(View.GONE);
                goFullscreen();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                // สนใจเฉพาะหน้าหลัก รูปเดี่ยว ๆ โหลดไม่ขึ้นไม่ใช่เหตุให้โหลดใหม่ทั้งหน้า
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && !request.isForMainFrame()) {
                    return;
                }
                String reason = null;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                        && error != null && error.getDescription() != null) {
                    reason = error.getDescription().toString();
                }
                fail(reason);
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                    fail(description);
                }
            }

            /**
             * เซิร์ฟเวอร์ตอบมาแล้ว แต่ตอบเป็น 5xx/404 — หน้าเว็บก็ไม่ขึ้นอยู่ดี
             * (เช่นคอนเทนเนอร์กำลังรีสตาร์ทแล้ว nginx ตอบ 502) ต้องนับเป็นล้มเหมือนกัน
             * ไม่งั้นทีวีค้างอยู่กับหน้า error ของ nginx ทั้งงานโดยไม่ลองใหม่เลย
             */
            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest request, WebResourceResponse response) {
                if (request != null && !request.isForMainFrame()) return;
                fail("HTTP " + (response == null ? "?" : String.valueOf(response.getStatusCode())));
            }

            /**
             * ใบรับรองมีปัญหา (หมดอายุ นาฬิกาทีวีเพี้ยน ชื่อโดเมนไม่ตรง)
             *
             * เดิม **ไม่มี** เมธอดนี้เลย ค่าเริ่มต้นของ WebView คือยกเลิกการโหลดเงียบ ๆ
             * โดยไม่เรียก onReceivedError → แอปค้างจอดำโดยไม่ลองใหม่และไม่บอกอะไรสักคำ
             *
             * ห้ามเรียก sslHandler.proceed() เด็ดขาด — ยอมให้ใบรับรองผิดผ่านไป
             * คือเปิดทางให้ใครก็ตามบนเส้นทางเน็ตยัดอะไรลงจอกลางงานได้
             */
            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler sslHandler, SslError error) {
                sslHandler.cancel();
                fail("SSL " + (error == null ? "?" : String.valueOf(error.getPrimaryError())));
            }
        });
    }

    /**
     * ที่อยู่ที่จะลอง เรียงตามลำดับ: ค่าที่ผู้ใช้ตั้งเอง (ถ้ามี) → โดเมนจริง → ไอพีในวง LAN
     *
     * ตัวสุดท้ายมีไว้เผื่อกรณีที่เจอมาแล้วจริง ๆ คือ DNS ของเครือข่ายที่สถานที่จัดงาน
     * ไม่รู้จักโดเมนนี้ หรือ hairpin NAT ใช้ไม่ได้
     */
    private void buildUrlList() {
        urls.clear();
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        if (!TextUtils.isEmpty(saved)) urls.add(saved);
        urls.add(getString(R.string.default_url));
        urls.add(getString(R.string.fallback_url));
        urlIndex = 0;
    }

    private String currentUrl() {
        return urls.get(urlIndex % urls.size());
    }

    private void load() {
        attemptFailed = false;
        status.setVisibility(View.VISIBLE);
        web.loadUrl(currentUrl());
    }

    /** นับการล้มของรอบโหลดนี้แค่ครั้งเดียว กันตั้งนาฬิกาลองใหม่ซ้อนกันหลายอัน */
    private void fail(String reason) {
        if (attemptFailed) return;
        attemptFailed = true;
        lastError = reason;
        scheduleRetry();
    }

    private void scheduleRetry() {
        failStreak += 1;

        // ที่อยู่นี้ยังไม่เคยพิสูจน์ตัวเอง → สลับทันที
        // เคยใช้ได้แล้วแต่ล้มติดกันหลายครั้ง → ยอมสลับ (ที่อยู่ที่เคยดีอาจตายไปแล้วจริง ๆ
        // เช่นย้ายทีวีออกจากวง LAN มาต่อ 5G) — ข้อนี้คือตัวกันอาการติดแหง็กถาวร
        if (!loaded || failStreak >= FAILS_BEFORE_SWITCH) {
            urlIndex += 1;
            loaded = false;
            failStreak = 0;
        }

        // ล้างหน้า error ของ WebView ทิ้งเป็นจอดำ ไม่งั้นมันบังข้อความสถานะไว้เต็มจอ
        // แล้วคนหน้างานจะเห็นแต่ "ERR_..." ภาษาอังกฤษ ไม่เห็นว่าแอปกำลังลองใหม่อยู่
        handler.post(() -> web.loadUrl("about:blank"));

        status.setVisibility(View.VISIBLE);
        StringBuilder text = new StringBuilder(getString(R.string.retrying));
        // บอกสาเหตุด้วย — บนทีวีเปิด DevTools ไม่ได้ บรรทัดนี้คือหลักฐานชิ้นเดียว
        // ที่บอกได้ว่าเป็นที่ DNS, ที่พอร์ต, ที่ใบรับรอง หรือที่ตัวเซิร์ฟเวอร์
        if (!TextUtils.isEmpty(lastError)) {
            text.append('\n').append(getString(R.string.error_reason, lastError));
        }
        text.append('\n').append(currentUrl())
                .append("\n\n").append(getString(R.string.settings_hint_line));
        status.setText(text.toString());

        handler.postDelayed(this::load, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }

    private void goFullscreen() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) goFullscreen();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            showUrlDialog();
            return true;
        }

        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // อยู่ในสไลด์โชว์ → ย้อนกลับไปหน้าเมนูให้เลือกแบบใหม่
            // อยู่ที่หน้าเมนูอยู่แล้ว → ต้องกดสองครั้งถึงจะออกจากแอป
            // กันกดโดนโดยไม่ตั้งใจกลางงานแล้วจอดับไปเฉย ๆ
            if (web.canGoBack()) {
                web.goBack();
                return true;
            }

            long now = System.currentTimeMillis();
            if (now - lastBackPress < 2000) {
                finish();
            } else {
                lastBackPress = now;
                Toast.makeText(this, "กดย้อนกลับอีกครั้งเพื่อออก", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        return super.onKeyDown(keyCode, event);
    }

    private void showUrlDialog() {
        final EditText input = new EditText(this);
        input.setHint(R.string.settings_hint);
        input.setText(currentUrl());

        new AlertDialog.Builder(this)
                .setTitle(R.string.settings_title)
                .setView(input)
                .setPositiveButton(R.string.save, (dialog, which) -> {
                    String value = input.getText().toString().trim();
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                            .putString(KEY_URL, value.isEmpty() ? null : value).apply();
                    restart();
                })
                .setNegativeButton(R.string.reset, (dialog, which) -> {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_URL).apply();
                    restart();
                })
                .show();
    }

    private void restart() {
        loaded = false;
        attemptFailed = false;
        failStreak = 0;
        lastError = null;
        retryDelay = RETRY_START_MS;
        handler.removeCallbacksAndMessages(null);
        buildUrlList();
        load();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        web.destroy();
        super.onDestroy();
    }
}
