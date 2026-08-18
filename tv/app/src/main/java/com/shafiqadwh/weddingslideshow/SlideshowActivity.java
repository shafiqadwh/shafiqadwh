package com.shafiqadwh.weddingslideshow;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
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

    private final Handler handler = new Handler(Looper.getMainLooper());

    private WebView web;
    private TextView status;
    private List<String> urls = new ArrayList<>();
    private int urlIndex = 0;
    private long retryDelay = RETRY_START_MS;
    private boolean loaded = false;
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
            @Override
            public void onPageFinished(WebView v, String url) {
                loaded = true;
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
                scheduleRetry();
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                    scheduleRetry();
                }
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

    private void load() {
        status.setVisibility(View.VISIBLE);
        web.loadUrl(urls.get(urlIndex % urls.size()));
    }

    private void scheduleRetry() {
        // ยังไม่เคยโหลดสำเร็จเลย แปลว่าที่อยู่นี้อาจใช้ไม่ได้ → สลับไปตัวถัดไป
        if (!loaded) urlIndex += 1;

        status.setVisibility(View.VISIBLE);
        status.setText(getString(R.string.retrying) + "\n"
                + urls.get(urlIndex % urls.size()) + "\n\n"
                + getString(R.string.settings_hint_line));

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
            // กันกดปุ่มย้อนกลับโดนโดยไม่ตั้งใจกลางงาน ต้องกดสองครั้งถึงจะออก
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
        input.setText(urls.get(urlIndex % urls.size()));

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
        retryDelay = RETRY_START_MS;
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
