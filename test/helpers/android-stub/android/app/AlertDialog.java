package android.app;
import android.content.Context;
import android.content.DialogInterface;
import android.view.View;
public class AlertDialog {
  public static class Builder {
    public Builder(Context c) {}
    public Builder setTitle(int id) { return this; }
    public Builder setView(View v) { return this; }
    public Builder setPositiveButton(int id, DialogInterface.OnClickListener l) { return this; }
    public Builder setNegativeButton(int id, DialogInterface.OnClickListener l) { return this; }
    public AlertDialog show() { return new AlertDialog(); }
  }
}
