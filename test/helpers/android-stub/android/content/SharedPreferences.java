package android.content;
import java.util.HashMap;
import java.util.Map;

/** เก็บในหน่วยความจำ พอให้ "ที่อยู่ที่ผู้ใช้ตั้งเอง" ทำงานได้จริงในเทสต์ */
public class SharedPreferences {
  public static final Map<String, String> STORE = new HashMap<>();
  public String getString(String key, String def) { return STORE.getOrDefault(key, def); }
  public Editor edit() { return new Editor(); }
  public static class Editor {
    public Editor putString(String key, String value) {
      if (value == null) STORE.remove(key); else STORE.put(key, value);
      return this;
    }
    public Editor remove(String key) { STORE.remove(key); return this; }
    public void apply() {}
  }
}
