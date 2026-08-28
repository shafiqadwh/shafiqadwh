package com.shafiqadwh.weddingslideshow;

import android.app.Activity;
import android.content.SharedPreferences;
import android.net.http.SslError;
import android.app.AlertDialog;
import android.os.Handler;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.widget.TextView;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * ตัวขับ `SlideshowActivity` ตัวจริงแทน Android — ไม่ใช่โค้ดของแอป ใช้ในเทสต์เท่านั้น
 *
 * จุดสำคัญที่ทำให้เทสต์นี้มีความหมาย: เวลาโหลดไม่ขึ้น WebView ของจริงเรียก
 * `onReceivedError` **แล้วตามด้วย `onPageFinished`** เพราะมันวาดหน้า error ของตัวเอง
 * เสร็จแล้วจริง ๆ ตัวขับนี้จึงยิงสองตัวนี้คู่กันเสมอ — ถ้าเลียนแบบไม่ครบตรงนี้
 * บั๊ก "ทีวีต่อ 5G แล้วติดแหง็กอยู่กับไอพีในวง LAN" จะไม่ปรากฏในเทสต์เลย
 *
 * อาร์กิวเมนต์: <ชื่อสถานการณ์> <จำนวนรอบสูงสุด> แล้วพิมพ์ผลออก stdout ทีละบรรทัด
 */
public class Driver {

    private static final String HTTPS = "https://wedding.shafiq-lap.com/slideshow/menu?lite=1&tv=1";
    private static final String LAN = "http://192.168.2.2:18090/slideshow/menu?lite=1&tv=1";

    public static void main(String[] args) {
        String scenario = args[0];
        int rounds = Integer.parseInt(args[1]);

        // ค่าสตริงเรียงตามลำดับเดียวกับ R.java ที่เทสต์สร้างจาก strings.xml ตัวจริง
        Activity.STRINGS = Arrays.copyOfRange(args, 2, args.length);

        WebView.LOADED.clear();
        Handler.PENDING.clear();
        SharedPreferences.STORE.clear();

        // สถานการณ์ที่ไม่ต้องจำลองเครือข่ายเลย ตอบแล้วจบ
        if ("normalise".equals(scenario)) {
            String[] samples = {
                "wedding.shafiq-lap.com/slideshow", "  https://a.example/x  ",
                "http://192.168.2.2:18090/", "HTTPS://A.EXAMPLE/", "   ", null,
            };
            for (String sample : samples) {
                System.out.println("normalise:" + sample + " -> " + SlideshowActivity.normaliseUrl(sample));
            }
            return;
        }

        Set<String> reachable = new HashSet<>();
        Set<Integer> forcedFailures = new HashSet<>();
        boolean sslInstead = false;
        boolean httpErrorInstead = false;
        boolean silentInstead = false;

        switch (scenario) {
            case "fiveg":
                // ทีวีต่อ 5G: โดเมนสาธารณะใช้ได้ ไอพีในวง LAN ไม่มีทางถึง
                // และครั้งแรกล้มแบบชั่วคราว (เน็ตมือถือสะดุดตอนเปิดแอป) — นี่คือเงื่อนไข
                // เดียวที่ต้องมีเพื่อให้โค้ดเก่าติดแหง็กถาวร
                reachable.add(HTTPS);
                forcedFailures.add(0);
                break;
            case "blip":
                // ใช้ได้อยู่ดี ๆ แล้วเน็ตสะดุดหนึ่งครั้ง — ห้ามหนีไปที่อยู่สำรอง
                reachable.add(HTTPS);
                forcedFailures.add(1);
                break;
            case "saved-lan":
                // เคยตั้งไอพีในวง LAN ไว้เองตอนอยู่บ้าน แล้วยกทีวีมาต่อ 5G
                SharedPreferences.STORE.put("url", LAN);
                reachable.add(HTTPS);
                break;
            case "ssl":
                reachable.add(HTTPS);
                sslInstead = true;
                break;
            case "duplicate-saved":
                // เจ้าภาพตั้งค่าเป็นที่อยู่เดียวกับค่าเริ่มต้นพอดี — ต้องไม่ลองซ้ำสองรอบ
                SharedPreferences.STORE.put("url", HTTPS);
                break;
            case "silent":
                // พอร์ตเปิดค้างแล้วเงียบ แพ็กเก็ตถูกดรอปทิ้ง — WebView ไม่เรียก callback ใด ๆ เลย
                silentInstead = true;
                break;
            case "keys":
                // ทุกที่อยู่ล้ม → จอสถานะขึ้นค้าง ซึ่งเป็นตอนที่ปุ่ม OK ต้องเปิดหน้าตั้งค่าได้
                break;
            case "keys-loaded":
                reachable.add(HTTPS);
                break;
            case "back-double-press":
                reachable.add(HTTPS);
                break;
            case "http-error":
                // เซิร์ฟเวอร์ตอบ แต่ตอบ 502 (คอนเทนเนอร์กำลังรีสตาร์ท)
                reachable.add(HTTPS);
                httpErrorInstead = true;
                forcedFailures.add(0);
                break;
            default:
                throw new IllegalArgumentException("ไม่รู้จักสถานการณ์ " + scenario);
        }

        int lastScripted = -1;
        for (int index : forcedFailures) lastScripted = Math.max(lastScripted, index);

        SlideshowActivity activity = new SlideshowActivity();
        activity.onCreate(null);

        WebView web = WebView.last;
        int attempt = 0;

        for (int round = 0; round < rounds; round++) {
            String url = web.url;
            if (url == null) break;

            if ("about:blank".equals(url)) {
                // หน้าเปล่าโหลดเสร็จก็เรียก onPageFinished เหมือนกัน — ห้ามนับเป็นสำเร็จ
                web.client.onPageFinished(web, url);
            } else {
                boolean ok = reachable.contains(url) && !forcedFailures.contains(attempt) && !sslInstead;
                if (silentInstead) System.out.println("silent:" + url);
                System.out.println((ok ? "serve:ok:" : "serve:fail:") + url);

                if (silentInstead) {
                    // ไม่ยิง callback อะไรเลย ปล่อยให้ตัวจับเวลาของแอปจัดการ
                } else if (ok) {
                    web.client.onPageFinished(web, url);
                } else if (sslInstead) {
                    SslErrorHandler sslHandler = new SslErrorHandler();
                    web.client.onReceivedSslError(web, sslHandler, new SslError(3));
                    System.out.println("ssl-cancelled:" + sslHandler.cancelled);
                    System.out.println("ssl-proceeded:" + sslHandler.proceeded);
                } else if (httpErrorInstead) {
                    web.client.onReceivedHttpError(web, mainFrame(), new WebResourceResponse(502));
                    web.client.onPageFinished(web, url);
                } else {
                    web.client.onReceivedError(web, mainFrame(), error("net::ERR_CONNECTION_TIMED_OUT"));
                    web.client.onPageFinished(web, url);
                }
                attempt += 1;
            }

            // เดินนาฬิกาหนึ่งก้าว: งานที่ตั้งไว้ทั้งหมดถึงเวลาพร้อมกัน
            List<Runnable> due = new ArrayList<>(Handler.PENDING);
            Handler.PENDING.clear();
            if (due.isEmpty()) {
                // ไม่มีอะไรค้างและบทที่เขียนไว้เล่นครบแล้ว = แอปนิ่งอยู่กับที่อยู่ปัจจุบัน
                if (attempt > lastScripted) break;
                // ยังมีเหตุที่ต้องจำลองอยู่ (เช่นเน็ตสะดุดหลังใช้ได้ดีมาพักหนึ่ง)
                // ปล่อยให้วนต่อ แล้วยิงใส่ที่อยู่เดิมที่แอปเปิดค้างไว้
            }
            for (Runnable r : due) r.run();
        }

        for (String shown : TextView.ALL_TEXTS) System.out.println("status:" + shown.replace('\n', '|'));
        System.out.println("web-visible:" + (web.getVisibility() == View.VISIBLE));
        System.out.println("web-paused:" + web.paused);
        System.out.println("web-stopped:" + web.stopped);

        if (scenario.startsWith("keys")) {
            // ปุ่ม OK ต้องเปิดหน้าตั้งค่าได้เฉพาะตอนจอสถานะขึ้นอยู่ ตอนสไลด์โชว์ทำงานปกติ
            // ปุ่มนี้ต้องเป็นของหน้าเว็บ (ใช้กดเลือกในหน้าเมนู) ห้ามแอปแย่งไป
            AlertDialog.SHOWN = 0;
            activity.onKeyDown(KeyEvent.KEYCODE_DPAD_CENTER, null);
            System.out.println("dialog-after-ok:" + AlertDialog.SHOWN);

            AlertDialog.SHOWN = 0;
            activity.onKeyDown(KeyEvent.KEYCODE_MENU, null);
            System.out.println("dialog-after-menu:" + AlertDialog.SHOWN);
        }

        if ("back-double-press".equals(scenario)) {
            SystemClock.NOW = 5_000_000;
            activity.onKeyDown(KeyEvent.KEYCODE_BACK, null);
            System.out.println("finished-after-one:" + activity.finished);

            SystemClock.NOW += 10_000;   // ปล่อยไว้สิบวินาที = คนละครั้งกัน
            activity.onKeyDown(KeyEvent.KEYCODE_BACK, null);
            System.out.println("finished-after-late-second:" + activity.finished);

            SystemClock.NOW += 500;      // กดซ้ำเร็ว ๆ = ตั้งใจออกจริง
            activity.onKeyDown(KeyEvent.KEYCODE_BACK, null);
            System.out.println("finished-after-quick-second:" + activity.finished);
        }

        for (String url : WebView.LOADED) System.out.println("load:" + url);
    }

    private static WebResourceRequest mainFrame() {
        return () -> true;
    }

    private static WebResourceError error(String description) {
        return new WebResourceError() {
            @Override public CharSequence getDescription() { return description; }
            @Override public int getErrorCode() { return -8; }
        };
    }
}
