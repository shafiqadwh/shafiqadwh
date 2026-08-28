package android.widget;
import android.view.View;

/** เก็บข้อความไว้ให้เทสต์อ่าน — บรรทัดสถานะบนจอคือสิ่งเดียวที่คนหน้างานเห็น */
public class TextView extends View {
  public CharSequence text = "";
  public TextView(android.content.Context c) { super(c); }
  public void setTextColor(int c) {}
  public void setTextSize(float size) {}
  public void setGravity(int g) {}
  public void setText(CharSequence value) { text = value; }
  public void setHint(int resId) {}
  public CharSequence getText() { return text; }
}
