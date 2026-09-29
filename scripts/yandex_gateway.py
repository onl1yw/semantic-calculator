"""Build an OpenAPI gateway specification with mandatory SWS protection."""


def gateway_spec(container_id, account_id, security_profile_id, frontend):
    if not all((container_id, account_id, security_profile_id,
                frontend.get("bucket"), frontend.get("prefix"), frontend.get("html"))):
        raise ValueError("Container, gateway account, security profile and published frontend are required")
    integration = {
        "type": "serverless_containers", "container_id": container_id,
        "service_account_id": account_id,
    }

    def operation(name, parameters=()):
        return {"operationId": name, "parameters": list(parameters),
                "responses": {"200": {"description": "Application response"}},
                "x-yc-apigateway-integration": dict(integration)}

    def parameter(name, location="path", limit=64):
        return {"name": name, "in": location, "required": True,
                "schema": {"type": "string", "minLength": 1, "maxLength": limit}}

    def static_operation(name, object_key, parameters=()):
        result = operation(name, parameters)
        result["x-yc-apigateway-integration"] = {
            "type": "object_storage", "bucket": frontend["bucket"],
            "object": object_key, "service_account_id": account_id,
        }
        return result

    def static_path(name, object_key, parameters=()):
        return {method: static_operation(name + method.title(), object_key, parameters)
                for method in ("get", "head")}

    # This small HTML response is embedded in the gateway release. It renders
    # without a container or even a storage fetch, and retains browser policies.
    html_headers = {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; "
                                  "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
                                  "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    }
    html = {}
    for method in ("get", "head"):
        html[method] = operation("frontend" + method.title())
        html[method]["x-yc-apigateway-integration"] = {
            "type": "dummy", "http_code": 200, "http_headers": dict(html_headers),
            "content": {"*": frontend["html"] if method == "get" else ""},
        }
    prefix = frontend["prefix"]
    paths = {
        "/": html,
        "/favicon.svg": static_path("favicon", prefix + "/favicon.svg"),
        "/card.png": static_path("socialCard", prefix + "/card.png"),
        "/LICENSE": static_path("license", prefix + "/LICENSE"),
        "/NOTICE": static_path("notice", prefix + "/NOTICE"),
        # Vite asset filenames contain content hashes. Keeping their keys across
        # releases lets an already-open page finish loading its original assets.
        "/assets/{file+}": static_path("assets", "assets/{file}", [parameter("file", limit=256)]),
        "/api/health": {"get": operation("health")},
        "/api/words": {"get": operation("suggest", [parameter("prefix", "query")])},
        "/api/words/{word}/vector": {"get": operation("vector", [parameter("word")])},
        "/api/nearest": {"post": operation("nearest")},
    }
    return {
        "openapi": "3.0.0", "info": {"title": "Semantic Calculator", "version": "0.1.0"},
        "x-yc-apigateway": {"smartWebSecurity": {"securityProfileId": security_profile_id}},
        "paths": paths,
    }
