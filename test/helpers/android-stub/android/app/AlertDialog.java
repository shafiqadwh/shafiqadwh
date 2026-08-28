package android.app;
import android.content.Context;
import android.content.DialogInterface;
import android.view.View;
public class AlertDialog {
  /** นับว่ากล่องตั้งค่าถูกเปิดกี่ครั้ง */
  public static int SHOWN = 0;
  public static class Builder {
    public Builder(Context c) {}
    public Builder(Context c, int themeResId) {}
    public Builder setTitle(int id) { return this; }
    public Builder setView(View v) { return this; }
    public Builder setPositiveButton(int id, DialogInterface.OnClickListener l) { return this; }
    public Builder setNegativeButton(int id, DialogInterface.OnClickListener l) { return this; }
    public AlertDialog show() { SHOWN += 1; return new AlertDialog(); }
  }
}
