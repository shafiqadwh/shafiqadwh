package android.widget;
import android.view.View;

/** เก็บข้อความไว้ให้เทสต์อ่าน — บรรทัดสถานะบนจอคือสิ่งเดียวที่คนหน้างานเห็น */
public class TextView extends View {
  /** ทุกข้อความที่เคยขึ้นจอ ไม่ใช่แค่ตัวล่าสุด — จอสถานะเปลี่ยนหลายรอบระหว่างลองใหม่ */
  public static final java.util.List<String> ALL_TEXTS = new java.util.ArrayList<>();
  /** ข้อความล่าสุดที่ถูกตั้ง ให้เทสต์อ่านสิ่งที่คนหน้างานเห็นบนจอจริง */
  public static CharSequence LAST_TEXT = "";
  public CharSequence text = "";
  public TextView(android.content.Context c) { super(c); }
  public void setTextColor(int c) {}
  public void setTextSize(float size) {}
  public void setGravity(int g) {}
  public void setText(CharSequence value) { text = value; LAST_TEXT = value; ALL_TEXTS.add(String.valueOf(value)); }
  public void setHint(int resId) {}
  public CharSequence getText() { return text; }
}
