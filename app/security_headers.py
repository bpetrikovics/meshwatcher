CSP_HEADER = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.tailwindcss.com/3.4.19 https://unpkg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net 'sha256-Ivz1HqHz0902SyRgM1GT8czS+kDxFBzGC0OKtHeeJ+0=' 'unsafe-eval'; "
    "style-src 'self' https://unpkg.com https://cdnjs.cloudflare.com 'unsafe-inline'; "
    "img-src 'self' https://*.tile.openstreetmap.org https://unpkg.com data:; "
    "font-src 'self' https://cdnjs.cloudflare.com; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)

SECURITY_HEADERS = {
    "Content-Security-Policy": CSP_HEADER,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}


def set_security_headers(response):
    for name, value in SECURITY_HEADERS.items():
        response.headers[name] = value
    return response
