"""Build an OpenAPI gateway specification with mandatory SWS protection."""


def gateway_spec(container_id, account_id, security_profile_id):
    if not all((container_id, account_id, security_profile_id)):
        raise ValueError("Container, gateway account and security profile are required")
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

    paths = {
        "/": {"get": operation("frontend")},
        "/favicon.svg": {"get": operation("favicon")},
        "/card.png": {"get": operation("socialCard")},
        "/assets/{file+}": {"get": operation("assets", [parameter("file", limit=256)])},
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
