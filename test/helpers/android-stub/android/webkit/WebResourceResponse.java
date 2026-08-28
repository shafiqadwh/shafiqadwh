package android.webkit;
public class WebResourceResponse {
  private final int status;
  public WebResourceResponse(int status) { this.status = status; }
  public int getStatusCode() { return status; }
}
