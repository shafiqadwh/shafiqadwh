package android.webkit;
public class SslErrorHandler {
  public boolean cancelled = false, proceeded = false;
  public void cancel() { cancelled = true; }
  public void proceed() { proceeded = true; }
}
