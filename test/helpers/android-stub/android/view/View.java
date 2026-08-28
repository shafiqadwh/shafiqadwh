package android.view;
public class View {
  public static final int VISIBLE = 0, GONE = 8;
  public static final int SYSTEM_UI_FLAG_LAYOUT_STABLE = 256;
  public static final int SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION = 512;
  public static final int SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN = 1024;
  public static final int SYSTEM_UI_FLAG_HIDE_NAVIGATION = 2;
  public static final int SYSTEM_UI_FLAG_FULLSCREEN = 4;
  public static final int SYSTEM_UI_FLAG_IMMERSIVE_STICKY = 4096;
  public static final int INVISIBLE = 4;
  public int visibility = VISIBLE;
  public ViewGroup parent;
  public View(android.content.Context c) {}
  public void setVisibility(int v) { visibility = v; }
  public int getVisibility() { return visibility; }
  public ViewGroup getParent() { return parent; }
  public void setBackgroundColor(int c) {}
  public void setSystemUiVisibility(int flags) {}
  public void setVerticalScrollBarEnabled(boolean b) {}
  public void setHorizontalScrollBarEnabled(boolean b) {}
}
