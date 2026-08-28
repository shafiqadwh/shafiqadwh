package android.view;
public class Window {
  private final View decor = new View(null);
  public void addFlags(int flags) {}
  public View getDecorView() { return decor; }
}
