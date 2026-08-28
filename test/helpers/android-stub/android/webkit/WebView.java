package android.webkit;
import android.view.ViewGroup;
import java.util.ArrayList;
import java.util.List;

/** จด URL ทุกตัวที่ถูกสั่งโหลด — ลำดับนี้คือหลักฐานว่าแอปวนหาที่อยู่ถูกหรือติดแหง็ก */
public class WebView extends ViewGroup {
  public static WebView last;
  public static final List<String> LOADED = new ArrayList<>();

  public WebViewClient client;
  public String url;

  public WebView(android.content.Context c) { super(c); last = this; }
  public WebSettings getSettings() { return new WebSettings(); }
  public void setWebViewClient(WebViewClient value) { client = value; }
  public void loadUrl(String value) { url = value; LOADED.add(value); }
  public boolean stopped = false;
  public void stopLoading() { stopped = true; }
  public boolean canGoBack() { return false; }
  public void goBack() {}
  public boolean paused = false;
  public void onPause() { paused = true; }
  public void onResume() { paused = false; }
  public void destroy() {}
}
