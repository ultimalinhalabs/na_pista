import assert from "node:assert/strict";
import test from "node:test";
import * as categoryRepo from "../../src/modules/categories/repository.js";
import * as productRepo from "../../src/modules/products/repository.js";
import * as inventoryRepo from "../../src/modules/inventory/repository.js";
import * as orderRepo from "../../src/modules/orders/repository.js";
import * as serviceRepo from "../../src/modules/services/repository.js";

/**
 * F20 brief §13/§36: a repository function must never run without a
 * TenantContext, for BOTH modules. Synchronous guard, no DB connection needed.
 */
test("category repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => categoryRepo.insertCategory(undefined, { name: "x" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => categoryRepo.listCategories(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => categoryRepo.getCategory({}, "id"), /TenantContext/);
  await assert.rejects(() => categoryRepo.updateCategory({ organizationId: "" }, "id", {}), /TenantContext/);
});

test("product repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => productRepo.insertProduct(undefined, { name: "x" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => productRepo.listProducts(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => productRepo.getProduct({}, "id"), /TenantContext/);
  await assert.rejects(() => productRepo.updateProduct({ organizationId: "" }, "id", {}), /TenantContext/);
});

test("inventory repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => inventoryRepo.listBalances(undefined, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => inventoryRepo.getBalance(null, "product-id"), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => inventoryRepo.increaseBalance({}, "product-id", "1.000000"), /TenantContext/);
  await assert.rejects(() => inventoryRepo.decreaseBalance({ organizationId: "" }, "product-id", "1.000000"), /TenantContext/);
  const movementStub = { inventoryId: "inv-id", productId: "product-id", type: "RECEIPT" as const, quantity: "1.000000", actorType: "user" as const, actorId: "actor-id" };
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => inventoryRepo.insertMovement(undefined, movementStub), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => inventoryRepo.listMovements(null, "product-id", { limit: 10 }), /TenantContext/);
});

test("order repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => orderRepo.insertOrder(undefined, { currency: "AOA" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => orderRepo.listOrders(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => orderRepo.getOrder({}, "id"), /TenantContext/);
  await assert.rejects(() => orderRepo.updateOrderStatus({ organizationId: "" }, "id", "CONFIRMED"), /TenantContext/);
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => orderRepo.updateOrderCustomer(undefined, "id", null), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => orderRepo.recalculateOrderTotals(null, "id"), /TenantContext/);
  const itemStub = { orderId: "order-id", productId: "product-id", productName: "x", unitPrice: "1.00", quantity: "1.000000" };
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => orderRepo.insertOrderItem({}, itemStub), /TenantContext/);
  await assert.rejects(() => orderRepo.listOrderItems({ organizationId: "" }, "order-id"), /TenantContext/);
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => orderRepo.getOrderItem(undefined, "order-id", "item-id"), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => orderRepo.updateOrderItemQuantity(null, "order-id", "item-id", "1.000000"), /TenantContext/);
  await assert.rejects(() => orderRepo.deleteOrderItem({ organizationId: "" }, "order-id", "item-id"), /TenantContext/);
});

test("service repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => serviceRepo.insertService(undefined, { name: "x", durationMinutes: 30 }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => serviceRepo.listServices(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => serviceRepo.getService({}, "id"), /TenantContext/);
  await assert.rejects(() => serviceRepo.updateService({ organizationId: "" }, "id", {}), /TenantContext/);
});
