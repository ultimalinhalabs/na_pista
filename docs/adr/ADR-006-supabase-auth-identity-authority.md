# ADR-006 — Supabase Auth como autoridade de identidade

- **Estado:** Accepted (CLAUDE.md §5–§6; brief §12)
- **Data:** 2026-09-21

## Context
Platform, Console e Client já usam o mesmo projecto Supabase Auth; o Na Pista precisa de identificar humanos.

## Decision
O Na Pista **não** tem sistema de autenticação nem armazena passwords. Verifica o JWT Supabase no servidor (JWKS
pública; `iss`, `aud=authenticated`, expiração). Claims identificam o utilizador; a **autorização** vem do Platform
(membership) e da política local (permissions). Nunca `user_metadata` como fronteira de segurança, nunca service role
no frontend. Serviços usam API keys `ulk_` (identidade de máquina), nunca sessão humana como mecanismo de longo prazo.

## Alternatives
- Auth própria (rejeitada: duplica passwords/sessões).
- Claims de role no JWT (rejeitada: editáveis/desactualizadas; não são fonte de verdade).

## Consequences
- (+) Um utilizador = uma identidade em todo o ecossistema.
- (−) Reencaminhar o JWT do utilizador para o Platform (`/v1/me`) é delegação por pedido — reserva registada em OD-12.
