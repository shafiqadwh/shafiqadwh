package android.net.http;
public class SslError {
  private final int primary;
  public SslError(int primary) { this.primary = primary; }
  public int getPrimaryError() { return primary; }
}
