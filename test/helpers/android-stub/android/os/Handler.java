package android.os;
import java.util.ArrayList;
import java.util.List;

/**
 * ไม่มีเธรด ไม่มีเวลาจริง — งานที่ถูกตั้งไว้จะรอจนกว่าเทสต์จะสั่งให้เดิน
 * ทำให้เทสต์คุมลำดับเหตุการณ์ได้ทั้งหมดโดยไม่ต้อง sleep
 */
public class Handler {
  public static final List<Runnable> PENDING = new ArrayList<>();
  public Handler(Looper l) {}
  public boolean post(Runnable r) { PENDING.add(r); return true; }
  public boolean postDelayed(Runnable r, long delay) { PENDING.add(r); return true; }
  public void removeCallbacksAndMessages(Object token) { PENDING.clear(); }
}
