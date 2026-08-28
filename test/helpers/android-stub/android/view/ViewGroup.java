package android.view;
public class ViewGroup extends View {
  public ViewGroup(android.content.Context c) { super(c); }
  public void addView(View child, LayoutParams params) { child.parent = this; }
  public void removeView(View child) { child.parent = null; }
  public static class LayoutParams {
    public static final int MATCH_PARENT = -1, WRAP_CONTENT = -2;
    public LayoutParams(int w, int h) {}
  }
}
