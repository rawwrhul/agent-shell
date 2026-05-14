# Framer API Capabilities Audit

- Generated: 2026-05-14T07:52:10Z
- Package: `framer-api` @ 0.1.9
- .d.ts files scanned:
  - `node_modules/framer-api/dist/index.d.ts`

> Some greps below are intentionally broad — false positives are fine, misses aren't.

## Top-level exports and declarations

```typescript
22:declare class FramerPluginError extends Error {
25:declare class FramerPluginClosedError extends Error {
161:declare const getAiServiceInfo: unique symbol;
162:declare const sendTrackingEvent: unique symbol;
163:declare const getCurrentUser: unique symbol;
164:declare const getProjectInfo: unique symbol;
165:declare const environmentInfo: unique symbol;
166:declare const initialState: unique symbol;
167:declare const showUncheckedPermissionToasts: unique symbol;
168:declare const marshal: unique symbol;
169:declare const unmarshal: unique symbol;
170:declare const getHTMLForNode: unique symbol;
171:declare const setHTMLForNode: unique symbol;
172:declare const $framerInternal: {
185:declare const getAiServiceInfoMessageType = "INTERNAL_getAiServiceInfo";
186:declare const sendTrackingEventMessageType = "INTERNAL_sendTrackingEvent";
187:declare const getCurrentUserMessageType = "INTERNAL_getCurrentUser";
188:declare const getProjectInfoMessageType = "INTERNAL_getProjectInfo";
189:declare const getHTMLForNodeMessageType = "INTERNAL_getHTMLForNode";
190:declare const setHTMLForNodeMessageType = "INTERNAL_setHTMLForNode";
379:declare enum CSSUnit {
403:declare const classKey: "__class";
406:declare const fontClassDiscriminator = "Font";
419:declare const fontStyles: readonly ["normal", "italic"];
421:declare const fontWeights: readonly [100, 200, 300, 400, 500, 600, 700, 800, 900];
441:declare class Font {
479:declare const unsupportedComputedValueClass = "UnsupportedComputedValue";
480:declare const unsupportedComputedValueType = "unsupported";
489:declare class UnsupportedComputedValue extends ComputedValueBase {
496:declare function isComputedValue(value: unknown): value is ComputedValueBase;
742:declare const linearGradientType: "LinearGradient";
748:declare const radialGradientType: "RadialGradient";
757:declare const conicGradientType: "ConicGradient";
812:declare class LinearGradient extends GradientBase {
827:declare class RadialGradient extends GradientBase {
848:declare class ConicGradient extends GradientBase {
1326:declare function supportsPosition<T extends PartialNodeData>(node: T): node is T & WithPositionTrait;
1327:declare function supportsPins<T extends PartialNodeData>(node: T): node is T & WithPinsTrait;
1328:declare function supportsSize<T extends PartialNodeData>(node: T): node is T & WithSizeTrait;
1329:declare function supportsSizeConstraints<T extends PartialNodeData>(node: T): node is T & WithSizeConstraintsTrait;
1330:declare function supportsAspectRatio<T extends PartialNodeData>(node: T): node is T & WithAspectRatioTrait;
1331:declare function supportsName<T extends PartialNodeData>(node: T): node is T & WithNameTrait;
1332:declare function supportsVisible<T extends PartialNodeData>(node: T): node is T & WithVisibleTrait;
1333:declare function supportsLocked<T extends PartialNodeData>(node: T): node is T & WithLockedTrait;
1334:declare function supportsBackgroundColor<T extends AnyNode>(node: T): node is T & WithBackgroundColorTrait<TraitVariantNode>;
1335:declare function supportsBackgroundColorData<T extends Partial<AnyNodeData>>(node: T): node is T & WithBackgroundColorTrait<TraitVariantData>;
1336:declare function supportsBackgroundImage<T extends AnyNode>(node: T): node is T & WithBackgroundImageTrait<TraitVariantNode>;
1337:declare function supportsBackgroundImageData<T extends Partial<AnyNodeData>>(node: T): node is T & WithBackgroundImageTrait<TraitVariantData>;
1338:declare function supportsBackgroundGradient<T extends PartialNodeData>(node: T): node is T & WithBackgroundGradientTrait<TraitVariantNode>;
1339:declare function supportsBackgroundGradientData<T extends PartialNodeData>(node: T): node is T & WithBackgroundGradientTrait<TraitVariantData>;
1340:declare function supportsRotation<T extends PartialNodeData>(node: T): node is T & WithRotationTrait;
1341:declare function supportsOpacity<T extends PartialNodeData>(node: T): node is T & WithOpacityTrait;
1342:declare function supportsBorderRadius<T extends PartialNodeData>(node: T): node is T & WithBorderRadiusTrait;
1343:declare function supportsBorder<T extends AnyNode>(node: T): node is T & WithBorderTrait<TraitVariantNode>;
1344:declare function supportsSVG<T extends PartialNodeData>(node: T): node is T & WithSVGTrait;
1345:declare function supportsTextTruncation<T extends PartialNodeData>(node: T): node is T & WithTextTruncationTrait;
1346:declare function supportsZIndex<T extends PartialNodeData>(node: T): node is T & WithZIndexTrait;
1347:declare function supportsOverflow<T extends PartialNodeData>(node: T): node is T & WithOverflowTrait;
1348:declare function supportsComponentInfo<T extends PartialNodeData>(node: T): node is T & WithComponentInfoTrait;
1349:declare function supportsFont<T extends PartialNodeData>(node: T): node is T & WithFontTrait<TraitVariantNode>;
1350:declare function supportsFontData<T extends PartialNodeData>(node: T): node is T & WithFontTrait<TraitVariantData>;
1351:declare function supportsInlineTextStyle<T extends PartialNodeData>(node: T): node is T & WithInlineTextStyleTrait<TraitVariantNode>;
1352:declare function supportsInlineTextStyleData<T extends PartialNodeData>(node: T): node is T & WithInlineTextStyleTrait<TraitVariantData>;
1353:declare function supportsLink<T extends PartialNodeData>(node: T): node is T & WithLinkTrait;
1354:declare function supportsImageRendering<T extends PartialNodeData>(node: T): node is T & WithImageRenderingTrait;
1355:declare function supportsLayout<T extends PartialNodeData>(node: T): node is T & WithLayoutTrait;
1356:declare function hasStackLayout<T extends PartialNodeData>(node: T): node is T & WithLayoutTrait & StackLayout;
1357:declare function hasGridLayout<T extends PartialNodeData>(node: T): node is T & WithLayoutTrait & GridLayout;
1358:declare function supportsComponentVariant<T extends PartialNodeData>(node: T): node is T & WithComponentVariantTrait;
1359:declare function isComponentVariant<T extends AnyNode>(node: T): node is T & IsComponentVariant;
1360:declare function isComponentGestureVariant<T extends AnyNode>(node: T): node is T & IsComponentGestureVariant;
1361:declare function supportsBreakpoint<T extends PartialNodeData>(node: T): node is T & WithBreakpointTrait;
1362:declare function isBreakpoint<T extends AnyNode>(node: T): node is T & IsBreakpoint;
1364:declare const colorStyleDiscriminator: "ColorStyle";
1421:declare class ColorStyle {
1494:declare function isColorStyle(value: unknown): value is ColorStyle;
1515:declare const textStyleDiscriminator: "TextStyle";
1601:declare class TextStyle {
1778:declare function isTextStyle(value: unknown): value is TextStyle;
1849:declare const booleanVariableClass = "BooleanVariable";
1850:declare const booleanVariableType: "boolean";
1870:declare class BooleanVariable extends VariableBase {
1877:declare const numberVariableClass = "NumberVariable";
1878:declare const numberVariableType: "number";
1898:declare class NumberVariable extends VariableBase {
1905:declare const stringVariableClass = "StringVariable";
1906:declare const stringVariableType: "string";
1926:declare class StringVariable extends VariableBase {
1933:declare const formattedTextVariableClass = "FormattedTextVariable";
1934:declare const formattedTextVariableType: "formattedText";
1951:declare class FormattedTextVariable extends VariableBase {
1958:declare const enumVariableClass = "EnumVariable";
1959:declare const enumVariableType: "enum";
1968:declare class EnumCase {
2036:declare class EnumVariable extends VariableBase {
2056:declare const colorVariableClass = "ColorVariable";
2057:declare const colorVariableType: "color";
2080:declare class ColorVariable extends VariableBase {
2087:declare const imageVariableClass = "ImageVariable";
2088:declare const imageVariableType: "image";
```

## References to a `framer` client instance

```typescript
86:     * Tip: if you have a local file (or bytes), upload it first (e.g. `framer.uploadImage(...)`) and
1404: * const colorStyle = await framer.createColorStyle({
1568: * const textStyle = await framer.createTextStyle({
1576: * const textStyle = await framer.createTextStyle({
1591: * const font = await framer.getFont("Open Sans")
1593: *   const textStyle = await framer.createTextStyle({ font })
1713:     * const textStyle = await framer.getTextStyle("text-style-id")
3091: * Use `framer.getManagedCollection()` to obtain an instance when the plugin is
3101:     * API](https://www.framer.com/developers/plugins-permissions) to check if users can edit the
3314:     * API](https://www.framer.com/developers/plugins-permissions) to check if users can edit the
3330:     * content via `framer.isAllowedTo`.
3334:     * const collection = await framer.getActiveCollection()
3336:     * if (framer.mode === "collection" && collection.managedBy !== "user") {
3337:     *   framer.notify("This Collection cannot be modified.", { variant: "warning" })
3673: * const selection = await framer.getSelection()
3676: * const node = await framer.getNode("some-node-id")
3679: * const frameNodes = await framer.getNodesWithType("FrameNode")
3762:     * const frameNodes = await framer.getNodesWithType("FrameNode")
3765:     * const selection = await framer.getSelection()
3790:     * const nodes = await framer.getNodesWithAttribute("backgroundColor")
3804:     * const nodes = await framer.getNodesWithAttributeSet("backgroundImage")
3938: * const selection = await framer.getSelection()
4631: *     framer.notify(result.reason ?? "Unknown error");
4635: *   framer.notify("Image uploaded successfully");
5146:     * await framer.addRedirects([
5451:     * if (framer.mode === "image" || framer.mode === "editImage") {
5463:     * if (framer.isAllowedTo("addImage")) await framer.addImage(...)
5464:     * if (framer.isAllowedTo("Collection.setItemOrder")) await collection.setItemOrder(...)
5483:     * Subscribe to changes in `framer.isAllowedTo(...methods)`:
5486:     * console.log(`Initial isAllowed: ${framer.isAllowedTo("addImage")}`)
5487:     * framer.subscribeToIsAllowedTo("addImage", (isAllowed) => {
5506:     * framer.showUI({
5523:     * framer.hideUI()
5538:     * await framer.hideUI()
5539:     * await framer.setBackgroundMessage("Syncing data...")
5542:     * await framer.setBackgroundMessage(null)
5557:     * await framer.closePlugin("Synchronization successful", {
5569:     * const user = await framer.getCurrentUser();
5619:     *     return framer.subscribeToPublishInfo(setPublishInfo)
5665:     * await framer.zoomIntoView("node-id")
5668:     * await framer.zoomIntoView(["node-id-1", "node-id-2"])
5788:     * framer.setCustomCode({
5804:     * const customCode = await framer.getCustomCode()
5825:     *   useEffect(() => framer.subscribeToCustomCode(setCustomCode), [])
5849:     * const collection = await framer.getActiveManagedCollection();
5866:     * const managedCollections = await framer.getManagedCollections();
5885:     * const collection = await framer.getActiveCollection();
5895:     * const collections = await framer.getCollections()
5912:     * const notification = framer.notify("An action was completed", {
5980:     * const font = await framer.getFont("Noto Sans")
5983:     * const font = await framer.getFont("Noto Sans", {
6004:     * const fonts = await framer.getFonts()
6016:     * const locales = await framer.getLocales()
6026:     * const defaultLocale = await framer.getDefaultLocale()
6040:     * const activeLocale = await framer.getActiveLocale()
6053:     * const groups = await framer.getLocalizationGroups()
6056:     * const pageGroups = await framer.getLocalizationGroups({ type: "page" })
6059:     * const specific = await framer.getLocalizationGroups({ groupIds: ["id1", "id2"] })
6071:     * await framer.setLocalizationData({
6095:     * const redirects = await framer.getRedirects()
```

## WebPageNode class body

```typescript
declare class WebPageNode extends NodeMethods implements EditableWebPageNodeAttributes, WithWebPageInfoTrait {
    #private;
    readonly [classKey]: WebPageNodeData[ClassKey];
    /**
     * The relative path to the WebPage
     */
    readonly path: string | null;
    /**
     * The Collection ID of the CMS Collection if the WebPage is a CMS Detail Page
     */
    readonly collectionId: string | null;
    constructor(rawData: WebPageNodeData, engine: PluginEngine);
    /**
     * Clone the WebPageNode into a new one with the same content and settings, as a draft
     * If the given path already exists, the cloned page will be created with a unique path.
     */
    clone(options?: WebPageCloneOptions): Promise<this>;
    /**
     * Get a list of breakpoints suggestions that can be added to the WebPage.
     *
     * @alpha
     */
    getBreakpointSuggestions(): Promise<readonly Breakpoint[]>;
    /**
     * Adds a new breakpoint to the web page.
     * @param breakpoint The breakpoint configuration to add
     * @returns a new FrameNode
     *
     * @alpha
     */
    addBreakpoint(basedOn: NodeId, breakpoint: Breakpoint): Promise<FrameNode>;
    /**
     * Get the active collection item for this CMS detail page.
     *
     * Returns null if this is not a detail page or the collection is empty.
     *
     * @alpha
     */
    getActiveCollectionItem(): Promise<CollectionItem | null>;
}
```

## TextNode class body

```typescript
declare class TextNode extends NodeMethods implements EditableTextNodeAttributes {
    #private;
    readonly [classKey]: TextNodeData[ClassKey];
    readonly name: string | null;
    readonly visible: boolean;
    readonly locked: boolean;
    readonly rotation: number;
    readonly opacity: number;
    readonly zIndex: WithZIndexTrait["zIndex"];
    readonly font: Font | null;
    readonly inlineTextStyle: TextStyle | null;
    readonly position: Position;
    readonly top: CSSDimension<CSSUnit.Pixel> | null;
    readonly right: CSSDimension<CSSUnit.Pixel> | null;
    readonly bottom: CSSDimension<CSSUnit.Pixel> | null;
    readonly left: CSSDimension<CSSUnit.Pixel> | null;
    readonly centerX: CSSDimension<CSSUnit.Percentage> | null;
    readonly centerY: CSSDimension<CSSUnit.Percentage> | null;
    readonly width: WidthLength | null;
    readonly height: HeightLength | null;
    readonly maxWidth: WidthConstraint | null;
    readonly minWidth: WidthConstraint | null;
    readonly maxHeight: HeightConstraint | null;
    readonly minHeight: HeightConstraint | null;
    readonly link: WithLinkTrait["link"];
    readonly linkOpenInNewTab: WithLinkTrait["linkOpenInNewTab"];
    readonly linkSmoothScroll: WithLinkTrait["linkSmoothScroll"];
    readonly linkClickTrackingId: WithLinkTrait["linkClickTrackingId"];
    readonly linkRelValues: WithLinkTrait["linkRelValues"];
    readonly linkPreserveParams: WithLinkTrait["linkPreserveParams"];
    readonly gridItemFillCellWidth: WithGridItemTrait["gridItemFillCellWidth"];
    readonly gridItemFillCellHeight: WithGridItemTrait["gridItemFillCellHeight"];
    readonly gridItemHorizontalAlignment: WithGridItemTrait["gridItemHorizontalAlignment"];
    readonly gridItemVerticalAlignment: WithGridItemTrait["gridItemVerticalAlignment"];
    readonly gridItemColumnSpan: WithGridItemTrait["gridItemColumnSpan"];
    readonly gridItemRowSpan: WithGridItemTrait["gridItemRowSpan"];
    readonly overflow: WithOverflowTrait["overflow"];
    readonly overflowX: WithOverflowTrait["overflowX"];
    readonly overflowY: WithOverflowTrait["overflowY"];
    readonly textTruncation: WithTextTruncationTrait["textTruncation"];
    constructor(rawData: TextNodeData, engine: PluginEngine);
    /**
     * Set the text of this node.
     *
     * Plain text content, not HTML.
     *
     * Use `"TextNode.setText"` to check if this method is allowed.
     */
    setText(text: string): Promise<void>;
    /**
     * Get the text of this node.
     *
     * Plain text content, not HTML.
     */
    getText(): Promise<string | null>;
    /**
     * Set the HTML of this node
     *
     * @alpha This an early API, and maybe heavily refactored in the future.
     */
    setHTML(html: string): Promise<void>;
    /**
     * Get HTML of this node
     *
     * @alpha This an early API, and maybe heavily refactored in the future.
     */
    getHTML(): Promise<string | null>;
}
```

## CMS-related symbols

```typescript
577:interface WithCollectionItemId {
580:interface ScrollSectionSelector extends Partial<WithCollectionItemId> {
583:interface LinkToWebPage extends Partial<WithCollectionItemId> {
1054:    /** Collection ID for the web page. Supported by WebPageNode. */
2300: * Base class for all CMS Collection field types. Use the `type` property
2347: * A CMS Collection field that stores a boolean (true or false) value.
2354: * A CMS Collection field that stores a color value (RGBA/HSL/HEX format).
2361: * A CMS Collection field that stores a numeric value.
2368: * A CMS Collection field that stores a text string value.
2378: * A CMS Collection field that stores HTML-formatted text content (H1-H6, P, and other standard content elements).
2385: * A CMS Collection field that stores an image asset (`ImageAsset`).
2392: * A CMS Collection field that stores a URL in string format.
2399: * A CMS Collection field that stores a date in UTC format. Optionally displays time.
2425: * A CMS Collection field that stores a file asset (`FileAsset`).
2436: * A CMS Collection field with a fixed set of enum cases (options) that the user
2507: * A CMS Collection field that stores an array of nested fields. Currently only
2517:/** Union of all CMS Collection field types. */
2698:interface BaseCollectionItemData {
2702:interface ApiV2CollectionItemData extends BaseCollectionItemData {
2710:interface CollectionItemSerializableData extends BaseCollectionItemData {
2724:interface CollectionItemData extends BaseCollectionItemData {
2734:interface ApiV2ManagedCollectionItemInput extends BaseCollectionItemData {
2742:interface ManagedCollectionItemInput extends BaseCollectionItemData {
2754:interface ApiV2CreateCollectionItem extends BaseCollectionItemData {
2762:interface CreateCollectionItem extends BaseCollectionItemData {
2774:interface ApiV2EditableCollectionItemAttributes extends BaseCollectionItemData {
2780:interface EditableCollectionItemAttributes extends BaseCollectionItemData {
2790:interface ApiV2EditableCollectionItemAttributesWithId extends ApiV2EditableCollectionItemAttributes {
2794:interface EditableCollectionItemAttributesWithId extends EditableCollectionItemAttributes {
2798:type ApiV2CollectionItemInput = ApiV2CreateCollectionItem | ApiV2EditableCollectionItemAttributesWithId;
2799:type CollectionItemInput = CreateCollectionItem | EditableCollectionItemAttributesWithId;
3081: * A CMS Collection that is fully controlled by a plugin.
3088: * A Managed Collection plugin becomes available within the CMS when it supports
3089: * both `configureManagedCollection` and `syncManagedCollection` modes.
3091: * Use `framer.getManagedCollection()` to obtain an instance when the plugin is
3095:declare class ManagedCollection implements Navigable {
3106:     * Returns who manages this Collection.
3108:     * - `"thisPlugin"` if the Collection is managed by the current plugin.
3109:     * - `"anotherPlugin"` if the Collection is managed by a different plugin.
3116:     * Retrieve all item IDs in this Managed Collection, in their current order.
3129:     * Use `"ManagedCollection.setItemOrder"` to check if this method is allowed.
3140:     * Get all fields defined on this Managed Collection.
3151:     * Add, update, or remove Collection fields.
3164:     * by the plugin when using `addItems`.
3166:     * Use `"ManagedCollection.setFields"` to check if this method is allowed.
3189:     * Currently, calling `addItems` with existing item IDs merges the provided
3196:     * Use `"ManagedCollection.addItems"` to check if this method is allowed.
3202:     * await collection.addItems([
3214:    addItems(items: ManagedCollectionItemInput[]): Promise<void>;
3218:     * Use `"ManagedCollection.removeItems"` to check if this method is allowed.
```

## Publish / deploy / preview

```typescript
4559:    /** Inverts SVG drag preview in dark mode. Defaults to true. */
4582: * - `"image"` - An image with an optional preview image, alt text, and resolution.
4583: * - `"svg"` - An SVG string with an optional preview image. Use `invertInDarkMode` to invert the drag preview in dark mode.
4648:declare const publish: unique symbol;
4650:declare const deploy: unique symbol;
4651:declare const getChangedPaths: unique symbol;
4679:    readonly publish: typeof publish;
4681:    readonly deploy: typeof deploy;
4682:    readonly getChangedPaths: typeof getChangedPaths;
4782:declare const unprotectedMessageTypesSource: ["closeNotification", "closePlugin", "setCloseWarning", "getActiveCollection", "getActiveLocale", "getActiveManagedCollection", "getCanvasRoot", "getChildren", "getCollection", "getCollectionFields", "getCollectionFields2", "getCollectionItems", "getCollectionItems2", "getCollections", "getColorStyle", "getColorStyles", "getCurrentUser", "getCurrentUser2", "getCustomCode", "getDefaultLocale", "getFont", "getFonts", "getImage", "getImageData", "getLocales", "getLocaleLanguages", "getLocaleRegions", "getLocalizationGroups", "getManagedCollection", "getManagedCollectionFields", "getManagedCollectionFields2", "getManagedCollectionItemIds", "getManagedCollections", "getNode", "getNodesWithAttribute", "getNodesWithAttributeSet", "getNodesWithType", "getParent", "getPluginData", "getPluginDataForNode", "getPluginDataKeys", "getPluginDataKeysForNode", "getProjectInfo", "getProjectInfo2", "getPublishInfo", "getRect", "getSelection", "getSVGForNode", "getText", "getTextForNode", "getTextStyle", "getTextStyles", "hideUI", "setBackgroundMessage", "notify", "onPointerDown", "setActiveCollection", "setSelection", "showUI", "getCodeFileVersionContent", "typecheckCode", "getCodeFileVersions", "getCodeFiles", "getCodeFile", "unstable_getDependencyVersion", "getRedirects", "uploadFile", "uploadFiles", "uploadImage", "uploadImages", "zoomIntoView", "navigateTo", "getRuntimeErrorForModule", "getRuntimeErrorForCodeComponentNode", "showProgressOnInstances", "removeProgressFromInstances", "addComponentInstancePlaceholder", "updateComponentInstancePlaceholder", "removeComponentInstancePlaceholder", "setMenu", "showContextMenu", "getBreakpointSuggestionsForWebPage", "getActiveCollectionItemForWebPage", "getVariables", "getVectorSets", "getVectorSetItems", "getVectorSetItemVariables", "getChangedPaths", "getChangeContributors", "getDeployments", "readProjectForAgent", "getAgentSystemPrompt", "getAgentContext", "queryImagesForAgent", "reviewChangesForAgent", "getNodeForAgent", "getNodesForAgent", "getNodesOfTypesForAgent", "getScopeNodeForAgent", "getGroundNodeForAgent", "getParentNodeForAgent", "getAncestorsForAgent", "paginateForAgent", "serializeForAgent", "serializeNodesForAgent", "INTERNAL_getAiServiceInfo", "INTERNAL_sendTrackingEvent", "INTERNAL_getCurrentUser", "INTERNAL_getProjectInfo", "INTERNAL_getHTMLForNode", "getAiServiceInfo", "sendTrackingEvent", "unstable_getCodeFile", "unstable_getCodeFiles", "unstable_getCodeFileVersionContent", "unstable_getCodeFileLint2", "unstable_getCodeFileTypecheck2", "unstable_getCodeFileVersions", "lintCode"];
5020:    readonly [publish]: ["publish"];
5022:    readonly [deploy]: ["deploy"];
5023:    readonly [getChangedPaths]: [];
5597:     * Provides details such as the time of the most recent deploy or the URL of
5601:     * @returns The current publish info for both staging and production.
5606:     * Subscribe to publish info changes.
5608:     * The callback is called whenever publish info is updated (e.g., after a
5611:     * @param publishInfoUpdate - Called when publish info changes.
6520:    [$framerApiOnly.publish](): Promise<PublishResult>;
6524:    [$framerApiOnly.deploy](deploymentId: string, domains?: string[]): Promise<Hostname[]>;
6526:    [$framerApiOnly.getChangedPaths](): Promise<{
6605:     * Executes the publish flow on behalf of an agent.
6609:     * @param input - Action-discriminated input object (preview / confirm_publish / deploy_to_production).
6610:     * @returns The action's result — status, publish URLs, and any errors, warnings, or changes.
6615:     * candidate images with preview thumbnails and a `url` field for each. The returned URLs are
7080:    publish: () => Promise<PublishResult>;
7084:    deploy: (deploymentId: string, domains?: string[]) => Promise<Hostname[]>;
7086:    getChangedPaths: () => Promise<{
```

## SEO / meta fields

```typescript
```

## URL / path / slug controls

```typescript
204:    /** The URL slug used for this locale, e.g. `"en"`. */
205:    slug: string;
224:    /** URL slug for the locale (e.g., "en"). If not provided, one is derived from the code. */
225:    slug?: string;
287:type LocalizationSourceType = "string" | "formattedText" | "altText" | "slug" | "link";
295:    /** The type of value for this source, such as `"string"`, `"formattedText"`, `"altText"`, `"slug"`, or `"link"`. */
2705:    /** Unique slug. */
2706:    slug: string;
2717:    /** Unique slug. */
2718:    slug: string;
2727:    /** Unique slug. */
2728:    slug: string;
2735:    /** Required unique ID of your choice. Using an ID instead of the slug helps avoid data loss. */
2738:    slug: string;
2743:    /** Required unique ID of your choice. Using an ID instead of the slug helps avoid data loss. */
2746:    slug: string;
2747:    /** Localized values for the slug */
2758:    slug: string;
2766:    slug: string;
2767:    /** Localized values for the slug */
2776:    slug?: string | undefined;
2782:    slug?: string | undefined;
2783:    /** Localized values for the slug */
3186:     * Each item requires an `id` and `slug`. Custom field data is provided via
3205:     *     slug: "item-1",
3292:     * The name of the field used as the slug.
3298:     * The ID of the field the slug is based on.
3441:     * - `slug` should be unique.
3451:     *   slug: "eric",
3459:     * await collection.addItems([{ id: "aBc123", slug: "bar" }])
```

## connect / disconnect signatures

```typescript
7685:declare function connect(projectUrlOrId: string, token?: string, options?: ConnectOptions): Promise<Framer>;
7686-/**
7687- * Connect to a Framer project and execute a callback with the Framer instance.
7688- * The connection will be closed automatically when the resolves.
```

## Questions to answer from the output above

- [ ] **Clone a page** — method name and full signature:
- [ ] **Set text content** on an existing node — method and signature:
- [ ] **Create a CMS item** — method, required fields, optional fields:
- [ ] **Set URL path / slug** on a new page or CMS item:
- [ ] **Set SEO meta** on a CMS item (even if page-level is unavailable):
- [ ] **Publish** — does preview vs production exist? What triggers each?

## Path decision (Phase 1 commit — one box only)

- [ ] **A** — CMS-driven articles (requires `addItems` with title/slug/body/meta)
- [ ] **B** — Clone template page + mutate text + publish
- [ ] **C** — Research + recommendation only (gaps too large to publish via API)

Rationale (one paragraph):

## Questions answered

- [x] **Clone a page** — `WebPageNode.clone(options?: WebPageCloneOptions): Promise<this>`
      where `WebPageCloneOptions = { path?: string }`. Creates a draft. Auto-uniquifies path on collision.
- [x] **Set text content** — `TextNode.setText(text: string): Promise<void>` (plain text)
      or `TextNode.setHTML(html: string): Promise<void>` (alpha, rich). Permission-gated.
- [x] **Create a CMS item** — `Collection.addItems(items: CollectionItemInput[]): Promise<void>`
      on regular user-created Collections (line 3462). Required: `slug`. Optional: `id` (creates
      if absent, updates if present), `fieldData: Record<fieldId, { type, value }>`.
- [x] **Set URL path / slug** — CMS items: `slug` required on every item input.
      Pages: `path` settable via `WebPageCloneOptions`. Also `createWebPage(pagePath)` for
      from-scratch creation. `framer.addRedirects([...])` available as override.
- [~] **Set SEO meta on a CMS item** — Not first-class in the SDK. BUT: `Collection.addFields`
      lets us add arbitrary string fields (e.g. `metaTitle`, `metaDescription`) to the schema.
      If Tarino's blog collection's detail-page template already binds such fields to Framer's
      SEO config (one-time UI setup), then `fieldData[metaTitleFieldId] = { type: "string", value: "..." }`
      IS setting SEO meta.
- [x] **Publish — preview vs production** — `framer.publish(): Promise<PublishResult>` creates
      a deployment (preview). `framer.getDeployments()` lists them with URLs. `framer.deploy(deploymentId, domains?)`
      promotes to production. All marked @alpha but documented and functional.

## Path decision: A1 — CMS-driven articles via Collection.addItems

**Rationale.** Tarino's blog is almost certainly a user-created Collection, not a plugin-managed
one. `Collection.addItems` is the supported write path for those. The flow is: research keywords →
draft article content + slug → look up blog collection by name → `getFields()` to resolve field
name→ID mapping → `addItems([{slug, fieldData}])` → `publish()` → file approval card with preview
URL → on approval, `deploy(deploymentId)`. SEO meta is solved by ensuring Tarino's blog collection
schema includes `metaTitle` and `metaDescription` string fields bound to the detail-page SEO config
in Framer's UI (one-time setup, do it ourselves if needed via `addFields` or ask Tarino to add them).
Path B (clone + setText) becomes the fallback only if a non-blog landing page is ever the target.