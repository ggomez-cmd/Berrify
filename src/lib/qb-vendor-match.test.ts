import { describe, expect, it } from "vitest";
import {
  classifyInvoiceSide,
  connectionIdForInvoiceVendors,
  matchQbVendor,
  vendorsForConnection,
} from "./qb-vendor-match";

const kaneFood = {
  connection_id: "conn-kane",
  list_id: "1",
  full_name: "Jose Santiago Inc (food)",
  is_active: true,
};
const kaneLiquor = {
  connection_id: "conn-kane",
  list_id: "2",
  full_name: "Jose Santiago Inc (liquor)",
  is_active: true,
};
const semillaSingle = {
  connection_id: "conn-semilla",
  list_id: "9",
  full_name: "Local Farm",
  is_active: true,
};

describe("QB vendor match", () => {
  it("picks (food) when every SKU is food-side", () => {
    const match = matchQbVendor({
      printName: "JOSE SANTIAGO INC",
      lines: [
        { category: "food", description: "Chicken" },
        { category: "kitchen", description: "Cups" },
      ],
      vendors: [kaneFood, kaneLiquor],
    });
    expect(match.fullName).toBe("Jose Santiago Inc (food)");
    expect(match.reason).toBe("food");
  });

  it("picks (liquor) when every SKU is beverage", () => {
    const match = matchQbVendor({
      printName: "Jose Santiago Inc",
      lines: [{ category: "beverage", description: "Ron" }],
      vendors: [kaneFood, kaneLiquor],
    });
    expect(match.fullName).toBe("Jose Santiago Inc (liquor)");
    expect(match.reason).toBe("liquor");
  });

  it("leaves mixed food + liquor unset", () => {
    const match = matchQbVendor({
      printName: "Jose Santiago",
      lines: [
        { category: "food", description: "Chicken" },
        { category: "beverage", description: "IPA" },
      ],
      vendors: [kaneFood, kaneLiquor],
    });
    expect(match.fullName).toBeNull();
    expect(match.reason).toBe("mixed");
    expect(match.options).toEqual(["Jose Santiago Inc (food)", "Jose Santiago Inc (liquor)"]);
  });

  it("uses the only suffix when QB has one side", () => {
    const match = matchQbVendor({
      printName: "Jose Santiago Inc",
      lines: [{ category: "beverage", description: "Rum" }],
      vendors: [kaneFood],
    });
    expect(match.fullName).toBe("Jose Santiago Inc (food)");
    expect(match.reason).toBe("only_suffix");
  });

  it("uses a single unsuffixed FullName", () => {
    const match = matchQbVendor({
      printName: "Local Farm",
      lines: [{ category: "food", description: "Lettuce" }],
      vendors: [semillaSingle],
    });
    expect(match.fullName).toBe("Local Farm");
    expect(match.reason).toBe("single");
  });

  it("falls back to vendor_aliases when the QB list is empty", () => {
    const match = matchQbVendor({
      printName: "CAN ENTERPRISE",
      lines: [{ category: "food", description: "Oil" }],
      vendors: [],
      aliases: [{ match_text: "can enterprise", supplier_id: "sup-1", qbo_vendor_name: "Jose Santiago Inc" }],
    });
    expect(match.fullName).toBe("Jose Santiago Inc");
    expect(match.reason).toBe("alias");
  });

  it("uses a restaurant QuickBooks Online connection instead of the shared Desktop file", () => {
    const connectionId = connectionIdForInvoiceVendors(
      "rest-semilla",
      [
        { id: "conn-kane", restaurant_id: "rest-kane", is_active: true },
        { id: "conn-shared", restaurant_id: null, is_active: true },
      ],
      [{ id: "qbo-semilla", restaurant_id: "rest-semilla", is_active: true }],
    );
    expect(connectionId).toBe("qbo-semilla");
    expect(
      vendorsForConnection(connectionId, [
        { ...semillaSingle, connection_id: "qbo-semilla" },
        kaneFood,
      ]),
    ).toEqual([{ ...semillaSingle, connection_id: "qbo-semilla" }]);
  });

  it("keeps Kane on Desktop when another restaurant is Online", () => {
    expect(
      connectionIdForInvoiceVendors(
        "rest-kane",
        [{ id: "conn-kane", restaurant_id: "rest-kane", is_active: true }],
        [{ id: "qbo-semilla", restaurant_id: "rest-semilla", is_active: true }],
      ),
    ).toBe("conn-kane");
  });

  it("never uses Kane vendors for a Semilla connection", () => {
    const connectionId = connectionIdForInvoiceVendors("rest-semilla", [
      { id: "conn-kane", restaurant_id: "rest-kane", is_active: true },
      { id: "conn-semilla", restaurant_id: "rest-semilla", is_active: true },
    ]);
    expect(connectionId).toBe("conn-semilla");
    expect(vendorsForConnection(connectionId, [kaneFood, kaneLiquor, semillaSingle])).toEqual([semillaSingle]);
  });

  it("classifies food/kitchen/cleaning vs beverage and ignores tax", () => {
    expect(
      classifyInvoiceSide([
        { category: "food" },
        { category: "tax" },
        { category: "cleaning" },
      ]),
    ).toBe("food");
    expect(classifyInvoiceSide([{ category: "beverage" }, { category: "tax" }])).toBe("liquor");
  });
});
