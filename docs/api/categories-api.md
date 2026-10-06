# Categories

Categories group products. Routes, request rules and examples are documented with products in
[products-api.md § Categories](products-api.md#categories); field shapes are in [openapi.json](openapi.json)
(`Category`).

| Operation | Route | Permission (scope) |
| --- | --- | --- |
| Create | `POST /v1/organizations/{organizationId}/categories` | `categories.create` (`catalog.write`) |
| List (paginated; `status`; `sort` = `createdAt`\|`name`) | `GET …/categories` | `categories.read` (`catalog.read`) |
| Get | `GET …/categories/{categoryId}` | `categories.read` |
| Update | `PATCH …/categories/{categoryId}` | `categories.update` (`catalog.write`) |
| Archive (never a physical delete) | `DELETE …/categories/{categoryId}` → the archived category | `categories.delete` (OWNER/ADMIN) |
