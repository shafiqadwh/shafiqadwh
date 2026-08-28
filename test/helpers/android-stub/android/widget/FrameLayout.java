package android.widget;
import android.view.ViewGroup;
public class FrameLayout extends ViewGroup {
  public FrameLayout(android.content.Context c) { super(c); }
  public static class LayoutParams extends ViewGroup.LayoutParams {
    public int gravity;
    public LayoutParams(int w, int h) { super(w, h); }
  }
}
