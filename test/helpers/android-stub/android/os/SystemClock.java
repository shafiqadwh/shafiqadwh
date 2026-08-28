package android.os;
/** นาฬิกาที่นับตั้งแต่บูต — เทสต์เดินเวลาเองได้ ไม่ต้องรอจริง */
public class SystemClock {
  public static long NOW = 0;
  public static long elapsedRealtime() { return NOW; }
}
