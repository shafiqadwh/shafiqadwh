package android.app;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;

public class Activity extends Context {
  public static final int MODE_PRIVATE = 0;
  /** คำแปลจริงจาก res/values/strings.xml — เทสต์เติมให้ก่อนสร้าง Activity */
  public static String[] STRINGS = new String[0];

  private final Window window = new Window();

  protected void onCreate(Bundle b) {}
  protected void onDestroy() {}
  public void onWindowFocusChanged(boolean hasFocus) {}
  public boolean onKeyDown(int keyCode, KeyEvent event) { return false; }
  public Window getWindow() { return window; }
  public void setContentView(View v) {}
  public String getString(int id) { return STRINGS[id]; }
  public String getString(int id, Object... args) {
    // แทนที่ %1$s ตัวเดียวก็พอ — เทสต์สนใจแค่ว่าสาเหตุถูกเอามาต่อในข้อความหรือเปล่า
    String value = STRINGS[id];
    return args.length == 0 ? value : value.replace("%1$s", String.valueOf(args[0]));
  }
  public SharedPreferences getSharedPreferences(String name, int mode) { return new SharedPreferences(); }
  public void finish() {}
}
