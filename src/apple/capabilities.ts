import type { ApplePlatform, Distribution } from './profiles.js'

/**
 * Every bundle ID capability an entitlement can need, one per line: the
 * capability's ID, the platforms it applies to (`i` iOS, with watchOS and
 * visionOS apps; `m` macOS; `t` tvOS), the entitlement keys that need it,
 * and after `|` its name. `key=a,b` gives the values that choose it where
 * several capabilities share a key, `@` the only distributions whose
 * profiles carry it, and `?` marks one Apple grants a team only on request.
 * A line that starts with spaces continues the one above.
 *
 * Sources: the developer portal's capability catalog that Xcode 27.1 ships
 * (DVTPortal.framework, DVTPortalCachedPortalCapabilities.json: 211
 * capabilities), which names each one's entitlement keys, platforms and
 * distributions; Sign in with Apple also signs Developer ID apps, which
 * the catalog leaves out. In-App Purchase and Nearby Interaction DL-TDoA
 * need no entitlement, so no key maps to them. The App Store Connect API
 * (OpenAPI specification 4.5.1) enables only `publicCapabilityTypes`; the
 * others are enabled through the developer site, as Xcode does.
 */
const table = `
9A63CFE5BEE0 m com.apple.security.virtualization | Virtualization
ACCESSORY_ACCESS_USB m com.apple.developer.accessory-access.usb | Claim USB Accessory
ACCESSORY_DATA_PROVIDER i com.apple.developer.accessory-data-provider | Accessory Data Provider
ACCESSORY_SETUP_KIT i
  com.apple.developer.accessory-setup-discovery-extension | Accessory Setup Extension
ACCESSORY_TRANSPORT_EXTENSION i
  com.apple.developer.accessory-transport-extension | Accessory Transport Extension
ACCESSORY_TRANSPORT_SECURITY i
  com.apple.developer.accessory-transport-security | Accessory Transport Security
ACCESS_WIFI_INFORMATION i com.apple.developer.networking.wifi-info | Access Wi-Fi Information
ACCOUNT_CREATION_PHONE_NUMBER im
  com.apple.developer.authentication-services.account-creation-requires-phone-number | Account Creation Requires Phone Number
APPLE_ID_AUTH imt com.apple.developer.applesignin | Sign In with Apple
APPLE_PAY im com.apple.developer.in-app-payments | Apple Pay Payment Processing
APP_ATTEST it com.apple.developer.devicecheck.appattest-environment | App Attest
APP_ATTEST_OPT_IN imt com.apple.developer.devicecheck.app-attest-opt-in | App Attest Opt-In
APP_COMPUTE_CATEGORY i com.apple.developer.app-compute-category ? | Increased Performance Headroom
APP_GROUPS imt com.apple.security.application-groups | App Groups
ARKIT_BARCODE_DETECTION i com.apple.developer.arkit.barcode-detection.allow
  ? | Spatial Barcode and QR code Scanning
ARKIT_HIGH_FREQUENCY_OBJECT_TRACKING i
  com.apple.developer.arkit.object-tracking-parameter-adjustment.allow ? | Object Tracking Parameter Adjustment
ARKIT_MAIN_CAMERA_ACCESS_ALLOW i
  com.apple.developer.arkit.main-camera-access.allow ? | Main Camera Access
ASSOCIATED_DOMAINS imt com.apple.developer.associated-domains | Associated Domains
AUTOFILL_CREDENTIAL_PROVIDER im
  com.apple.developer.authentication-services.autofill-credential-provider | AutoFill Credential Provider
AUTOMATED_DEVICE_ENROLLMENT i
  com.apple.developer.automated-device-enrollment.add-devices ? | Add Devices to Automated Device Enrollment
AUTOMATIC_ASSESSMENT_CONFIGURATION im
  com.apple.developer.automatic-assessment-configuration ? | Automatic Assessment Configuration
BACKGROUND_GPU_ACCESS i
  com.apple.developer.background-tasks.continued-processing.gpu | Background GPU Access
BROWSER_APP_INSTALLATION i com.apple.developer.browser.app-installation ? | Browser App Installation
BROWSER_JIT_ACCESS i com.apple.developer.cs.allow-jit ? | Web Browser JIT Access
BROWSER_JIT_WRITE_ALLOWLIST i com.apple.developer.cs.jit-write-allowlist ? | Web Browser JIT Write AllowList
CAMERA_REGION_ALLOW i com.apple.developer.arkit.camera-region.allow ? | Camera Region
CARKEY_SESSION i com.apple.developer.carkey.session ? | CarKey Session
CARPLAY_AUDIO_APP i com.apple.developer.playable-content ? | CarPlay Audio App
CARPLAY_AUTOMAKER_CONFIG i com.apple.developer.carplay-protocols ? | CarPlay Automaker
CARPLAY_CHARGING i com.apple.developer.carplay-charging ? | CarPlay EV Charging App
CARPLAY_COMMUNICATION i com.apple.developer.carplay-communication ? | CarPlay Communication App
CARPLAY_DRIVING_TASK i com.apple.developer.carplay-driving-task ? | CarPlay Driving Task App
CARPLAY_FUELING i com.apple.developer.carplay-fueling ? | CarPlay Fueling App
CARPLAY_PARKING i com.apple.developer.carplay-parking ? | CarPlay Parking App
CARPLAY_QUICK_FOOD_ORDERING i com.apple.developer.carplay-quick-ordering ? | CarPlay Quick Food Ordering App
CARPLAY_VOICE_BASED_CONVERSATION i
  com.apple.developer.carplay-voice-based-conversation ? | CarPlay Voice Based Conversation
CARRIER_CONSTRAINED_NETWORK_CAT_OPT i
  com.apple.developer.networking.carrier-constrained.app-optimized
  com.apple.developer.networking.carrier-constrained.appcategory | Carrier-Constrained Network Category and Optimized
CLASSKIT im com.apple.developer.ClassKit-environment | ClassKit
COMMCENTER_FINEGRAINED_ESIM i com.apple.CommCenter.fine-grained ? | eSim
CONNECTED_SHOPPING i
  com.apple.developer.proximity-reader.customer-engagement | Tap to Share
CONTACTLESS_NFC_HCE i com.apple.developer.nfc.hce
  com.apple.developer.nfc.hce.iso7816.select-identifier-prefixes ? | Host Card Emulation (HCE)
CONTACTLESS_PASS_PROVISIONING im
  com.apple.developer.contactless-payment-pass-provisioning=true ? | Contactless Pass Provisioning
CONTACTLESS_PASS_PROVISIONING_MAID i
  com.apple.developer.contactless-payment-pass-provisioning.maids ? | Contactless Pass Provisioning access for MAIDs
CONTACTLESS_PASS_PROVISIONING_SHAREDCREDENTIAL im
  com.apple.developer.contactless-payment-pass-provisioning=shareablecredential
  ? | Contactless Pass Provisioning (SharableCredential)
CONTACTS_NOTES_FIELD im com.apple.developer.contacts.notes ? | Contact Notes Field Access
COREMEDIA_HLS_LOW_LATENCY imt com.apple.developer.coremedia.hls.low-latency
  @development,adHoc,appStore,macAppStore | Low Latency HLS
COREMOTION_HEAD_POSE imt com.apple.developer.coremotion.head-pose | Head Pose
CORETELEPONY_SIMINSERTED i com.apple.developer.coretelephony.sim-inserted | SIM Inserted for Wireless Carriers
CRITICAL_ALERTS it com.apple.developer.usernotifications.critical-alerts ? | Critical Alerts
CRITICAL_MESSAGING i com.apple.developer.messages.critical-messaging | Critical Messaging
DATA_CONTAINER_ACCESS i
  com.apple.developer.app-migration.data-container-access | App Identifier for OS Data Transfer
DATA_PROTECTION it com.apple.developer.default-data-protection | Data Protection
DECLARED_AGE_RANGE im com.apple.developer.declared-age-range | Declared Age Range
DEFAULT_CALLING_APP i com.apple.developer.calling-app | Default Calling App
DEFAULT_CARRIER_MESSAGING_APP i com.apple.developer.carrier-messaging-app | Default Carrier Messaging App
DEFAULT_CONTACTLESS_NFC_HCE_APP i
  com.apple.developer.nfc.hce.default-contactless-app ? | Default Host Card Emulation (HCE) App
DEFAULT_MESSAGING_APP i com.apple.developer.messaging-app | Default Messaging App
DEFAULT_NAVIGATION_APP i com.apple.developer.navigation-app | Default Navigation App
DEFAULT_TRANSLATION_APP i com.apple.developer.translation-app | Default Translation App
DEFAULT_WEB_BROWSER i com.apple.developer.web-browser ? | Default Web Browser
DEVICE_DISCOVERY_PAIRING i
  com.apple.developer.device-discovery.pairing-access | Device Discovery Pairing Access
DEV_MANAGE_THREAD_NETWORK_CREDENTIALS i
  com.apple.developer.networking.manage-thread-network-credentials
  @development ? | Manage Thread Network Credentials (development)
DIALING_APP i com.apple.developer.dialing-app | Default Dialer App
DRIVERKIT_ALLOWTHIRDPARTY_USERCLIENTS im
  com.apple.developer.driverkit.allow-third-party-userclients
  @development,adHoc,appStore,macAppStore | DriverKit Allow Third Party UserClients
DRIVERKIT_ANYUSERCLIENTACCESS m
  com.apple.developer.driverkit.allow-any-userclient-access ? | DriverKit Allow Any UserClient Access
DRIVERKIT_ANYUSERCLIENTACCESS_PUB m
  com.apple.developer.driverkit.allow-any-userclient-access @development ? | DriverKit Allow Any UserClient (development)
DRIVERKIT_COMMUNICATESWITHDRIVERS i
  com.apple.developer.driverkit.communicates-with-drivers | DriverKit Communicates with Drivers
DRIVERKIT_ENDPOINT_SECURITY m com.apple.developer.endpoint-security.client
  @development,developerId ? | Endpoint Security
DRIVERKIT_FAMILY_AUDIO im com.apple.developer.driverkit.family.audio ? | DriverKit Family Audio
DRIVERKIT_FAMILY_AUDIO_PUB im com.apple.developer.driverkit.family.audio
  @development ? | DriverKit Family Audio (development)
DRIVERKIT_FAMILY_BLOCKSTORAGEDEVICE m
  com.apple.developer.driverkit.family.block-storage-device ? | DriverKit BlockStorageDevice
DRIVERKIT_FAMILY_HIDDEVICE_PUB m
  com.apple.developer.driverkit.family.hid.device @development ? | DriverKit Family HID Device (development)
DRIVERKIT_FAMILY_HIDEVENTSERVICE_PUB m
  com.apple.developer.driverkit.family.hid.eventservice @development ? | DriverKit Family HID EventService (development)
DRIVERKIT_FAMILY_MIDI im com.apple.developer.driverkit.family.midi ? | DriverKit Family MIDI
DRIVERKIT_FAMILY_MIDI_DEV im com.apple.developer.driverkit.family.midi
  @development ? | DriverKit Family MIDI (development)
DRIVERKIT_FAMILY_NETWORKING_PUB m
  com.apple.developer.driverkit.family.networking @development ? | DriverKit Family Networking (development)
DRIVERKIT_FAMILY_SCSICONTROLLER_PUB m
  com.apple.developer.driverkit.family.scsicontroller @development ? | DriverKit Family SCSIController (development)
DRIVERKIT_FAMILY_SERIAL_PUB m com.apple.developer.driverkit.family.serial
  @development ? | DriverKit Family Serial (development)
DRIVERKIT_HID m com.apple.developer.driverkit.transport.hid ? | DriverKit Transport HID
DRIVERKIT_HID_DEVICE m com.apple.developer.driverkit.family.hid.device ? | DriverKit Family HID Device
DRIVERKIT_HID_EVENT_SERVICE m
  com.apple.developer.driverkit.family.hid.eventservice ? | DriverKit HID EventService
DRIVERKIT_NETWORKING m com.apple.developer.driverkit.family.networking ? | DriverKit Family Networking
DRIVERKIT_PCIPRIMARYMATCH im com.apple.developer.driverkit.transport.pci ? | DriverKit PCI (PrimaryMatch)
DRIVERKIT_PCIPRIMARYMATCH_PUB im com.apple.developer.driverkit.transport.pci
  @development ? | DriverKit PCI (development)
DRIVERKIT_PUBLIC im com.apple.developer.driverkit @development ? | DriverKit (development)
DRIVERKIT_SCSI_CONTROLLER m
  com.apple.developer.driverkit.family.scsicontroller ? | DriverKit Family SCSI Controller
DRIVERKIT_SERIAL m com.apple.developer.driverkit.family.serial ? | DriverKit Family Serial
DRIVERKIT_TRANSPORT_HID_PUB m com.apple.developer.driverkit.transport.hid
  @development ? | DriverKit Transport HID (development)
DRIVERKIT_TRANSPORT_USB_VENDORID im
  com.apple.developer.driverkit.transport.usb ? | DriverKit USB Transport - VendorID
DRIVERKIT_USBTRANSPORT_PUB im com.apple.developer.driverkit.transport.usb
  @development ? | DriverKit USB Transport (development)
DRIVERKIT_USBTRANSPORT_VENDORPRODUCT im
  com.apple.developer.driverkit.transport.usb ? | DriverKit USB Transport - VendorID and ProductID
DRIVERKIT_USERCLIENTACCESS m com.apple.developer.driverkit.userclient-access
  ? | DriverKit UserClient Access
EMBEDDED_BROWSER_ENGINE i com.apple.developer.embedded-web-browser-engine ? | Embedded Browser Engine
ENABLED_FOR_MAC m com.apple.developer.associated-application-identifier
  @development,appStore,macAppStore,developerId | Mac Catalyst
ENERGYKIT im com.apple.developer.energykit
  @development,adHoc,appStore,macAppStore | EnergyKit
ENERGY_KIT_LOAD_EVENTS im
  com.apple.developer.energykit.loadevents-experience
  @development,adHoc,appStore,macAppStore | EnergyKit LoadEvents
ENHANCED_SECURITY im com.apple.security.hardened-process
  com.apple.security.hardened-process.checked-allocations
  com.apple.security.hardened-process.checked-allocations.enable-pure-data
  com.apple.security.hardened-process.checked-allocations.no-tagged-receive
  com.apple.security.hardened-process.checked-allocations.soft-mode
  com.apple.security.hardened-process.dyld-ro
  com.apple.security.hardened-process.enhanced-security-version
  com.apple.security.hardened-process.enhanced-security-version-string
  com.apple.security.hardened-process.hardened-heap
  com.apple.security.hardened-process.platform-restrictions
  com.apple.security.hardened-process.platform-restrictions-string | Enhanced Security
ENROLLMENT_SSO_CAPABLE i com.apple.developer.enrollment-sso-capable ? | Enrollment Single Sign On
EXTENDED_VIRTUAL_ADDRESSING it
  com.apple.developer.kernel.extended-virtual-addressing | Extended Virtual Addressing
EXTERNAL_LINK_ACCOUNT it com.apple.developer.storekit.external-link.account
  ? | External Link Account
FALL_DETECTION_NOTIFICATIONS i com.apple.developer.health.fall-detection ? | Fall Detection Notifications
FAMILY_CONTROLS i com.apple.developer.family-controls @development | Family Controls (Development)
FAMILY_CONTROLS_DISTRIBUTION i com.apple.developer.family-controls ? | Family Controls (Distribution)
FAMILY_CONTROLS_WEBSITE_USAGE i
  com.apple.developer.family-controls.app-and-website-usage | Family Controls App and Website Usage
FILEPROVIDER_TESTINGMODE im com.apple.developer.fileprovider.testing-mode
  @development,adHoc | FileProvider Testing Mode
FINANCEKIT_TRANSACTION_PICKER i
  com.apple.developer.financekit.transaction-picker | FinanceKit Transaction Picker UI
FINANCE_KIT i com.apple.developer.financekit ? | FinanceKit
FONTS_MANAGED i
  com.apple.developer.user-fonts=app-usage,system-installation,font-enumeration
  ? | Font Enumeration
FONT_INSTALLATION i
  com.apple.developer.user-fonts=app-usage,system-installation | Fonts
FOUNDATION_MODEL_ADAPTER im com.apple.developer.foundation-model-adapter ? | Foundation Model Adapter
FOVEATED_STREAMING_PROVIDER i
  com.apple.developer.foveated-streaming-provider ? | Foveated Streaming Provider
FOVEATED_STREAMING_SESSION i com.apple.developer.foveated-streaming-session | Foveated Streaming Session
FSKIT_MODULE m com.apple.developer.fskit.fsmodule | FSKit Module
FSKIT_MOUNTER m com.apple.developer.fskit.mount | FSKit Mounter
GAME_CENTER imt com.apple.developer.game-center
  @development,adHoc,appStore,macAppStore | Game Center
GROUP_ACTIVITIES imt com.apple.developer.group-session | Group Activities
HEALTHKIT i com.apple.developer.healthkit
  com.apple.developer.healthkit.access=health-records
  com.apple.developer.healthkit.background-delivery | HealthKit
HEALTHKIT_ACCESS_VHR i
  com.apple.developer.healthkit.access=verifiable-health-records ? | HealthKit Access (Verifiable Health Records)
HEALTHKIT_RECALIBRATE_ESTIMATES i
  com.apple.developer.healthkit.recalibrate-estimates | HealthKit Estimate Recalibration
HEALTHRESEARCH_BACKGROUND_PROCESSING i
  com.apple.developer.backgroundtasks.healthresearch ? | Health Research Background Processing
HEALTH_MOVEMENT_DISORDER i com.apple.developer.health-movement-disorder ? | Health Movement Disorder
HEARING_AID_APP i com.apple.developer.hearing-aid-app ? | Hearing Aid App
HID_VIRTUAL_DEVICE m com.apple.developer.hid.virtual.device ? | HID Virtual Device
HLS_INTERSTITIAL_PREVIEW imt
  com.apple.developer.coremedia.hls.interstitial-preview
  @development,adHoc,appStore,macAppStore | HLS Interstitial Previews
HOMEKIT it com.apple.developer.homekit | HomeKit
HOTSPOT_HELPER_MANAGED i com.apple.developer.networking.HotspotHelper ? | Hotspot Helper
HOT_SPOT i com.apple.developer.networking.HotspotConfiguration | Hotspot
ICLOUD imt com.apple.developer.ubiquity-kvstore-identifier
  com.apple.developer.icloud-container-environment
  com.apple.developer.ubiquity-container-identifiers
  com.apple.developer.icloud-services
  com.apple.developer.icloud-container-identifiers
  com.apple.developer.icloud-container-development-container-identifiers | iCloud
ICLOUD_EXTENDED_SHARE_ACCESS imt
  com.apple.developer.icloud-extended-share-access | iCloud Extended Share Access
INCREASED_MEMORY_LIMIT i com.apple.developer.kernel.increased-memory-limit | Increased Memory Limit
INCREASED_MEMORY_LIMIT_DEBUGGING i
  com.apple.developer.kernel.increased-debugging-memory-limit | Increased Debugging Memory Limit
INTER_APP_AUDIO i inter-app-audio | Inter-App Audio
IN_APP_PASS_PROVISIONING im com.apple.developer.payment-pass-provisioning ? | In-App Provisioning
IPAD_CAMERA_MULTITASKING i
  com.apple.developer.avfoundation.multitasking-camera-access | Multitasking Camera Access
JOURNALING_SUGGESTIONS i com.apple.developer.journal.allow | Journaling Suggestions
LOCATION_PUSH_SERVICE_EXT im com.apple.developer.location.push | Location Push Service Extension
LOW_LATENCY_STREAMING i com.apple.developer.low-latency-streaming | Low-Latency Streaming
MANAGED_APP_INSTALLATION_UI im
  com.apple.developer.managed-app-distribution.install-ui | Managed App Installation UI
MANAGE_THREAD_NETWORK_CREDENTIALS i
  com.apple.developer.networking.manage-thread-network-credentials ? | Manage Thread Network Credentials
MAPS m com.apple.developer.maps
  @development,appStore,macAppStore,developerId | Maps
MATTER_ALLOW_SETUP_PAYLOAD imt
  com.apple.developer.matter.allow-setup-payload | Matter Allow Setup Payload
MDM_MANAGED_ASSOCIATED_DOMAINS imt
  com.apple.developer.associated-domains.mdm-managed | MDM Managed Associated Domains
MEDIAEXTENSION_FORMATREADER m
  com.apple.developer.mediaextension.formatreader | Media Extension Format Reader
MEDIAEXTENSION_VIDEODECODER m
  com.apple.developer.mediaextension.videodecoder | Media Extension Video Decoder
MEDIA_DEVICE_DISCOVERY i
  com.apple.developer.media-device-discovery-extension | Media Device Discovery
MEDIA_SHARING_EXTENSION i com.apple.developer.media-device-extension | Media Sharing Extension
MEMORY_TRANSFER_ACCEPT i com.apple.developer.memory.transfer-accept ? | Memory Transfer Accept
MEMORY_TRANSFER_SEND i com.apple.developer.memory.transfer-send ? | Memory Transfer Send
MERCHANT_ACCESSIBILITY_CONTROL i
  com.apple.developer.accessibility.merchant-api-control | Accessibility Merchant API Control
MESSAGES_COLLABORATION im com.apple.developer.shared-with-you.collaboration
  @development,adHoc,appStore,macAppStore | Messages Collaboration
MOBILE_DOCUMENT_PROVIDER i
  com.apple.developer.identity-document-services.document-provider.mobile-document-types | Digital Credentials API - Mobile Document Provider
MP_APP_INSTALLATION i com.apple.developer.marketplace.app-installation ? | Alternative App Marketplace
MULTICAST_NETWORKING im com.apple.developer.networking.multicast ? | Multicast Networking
MULTIPATH i com.apple.developer.networking.multipath | Multipath
NETWORK_CUSTOM_PROTOCOL m com.apple.developer.networking.custom-protocol | Custom Network Protocol
NETWORK_EXTENSIONS imt com.apple.developer.networking.networkextension | Network Extensions
NETWORK_SLICING i com.apple.developer.networking.slicing.appcategory
  com.apple.developer.networking.slicing.trafficcategory | 5G Network Slicing
NETWORK_TOPOLOGY_OBSERVATION imt
  com.apple.developer.networking.topology-observation | Network Topology Observation
NFC_TAG_READING i com.apple.developer.nfc.readersession.formats | NFC Tag Reading
ON_DEMAND_INSTALL_CAPABLE i com.apple.developer.on-demand-install-capable | On Demand Install Capable
ONDEMANDINSTALL_EXTENSIONS i com.apple.developer.on-demand-install-capable | On Demand Install Capable for App Clip Extensions
PASSTHROUGH_CAMERA_ACCESSIBILITY i
  com.apple.developer.accessibility.arkit.main-camera-access.allow ? | Passthrough Camera Access
PASS_PRESENTATION_SUPPRESSION im
  com.apple.developer.passkit.pass-presentation-suppression
  @development,adHoc,appStore,macAppStore ? | Pass Presentation Suppression
PERSISTENT_CONTENT_CAPTURE m com.apple.developer.persistent-content-capture
  ? | Persistent Content Capture
PERSONAL_VPN im com.apple.developer.networking.vpn.api | Personal VPN
PRIVILEGED_FILE_OPERATIONS m
  com.apple.developer.security.privileged-file-operations ? | Privileged File Operations
PROTECTED_CONTENT i com.apple.developer.protected-content ? | Protected Content
PUSH_NOTIFICATIONS imt aps-environment com.apple.developer.aps-environment | Push Notifications
PUSH_TO_TALK i com.apple.developer.push-to-talk | Push to Talk
SCREENCAPTURE_INCLUDE_PASSTHROUGH i
  com.apple.developer.screen-capture.include-passthrough ? | Passthrough in Screen Capture
SENSITIVE_CONTENT_ANALYSIS im
  com.apple.developer.sensitivecontentanalysis.client
  @development,adHoc,appStore,macAppStore | Sensitive Content Analysis
SENSORKIT_READER_ACCESS i com.apple.developer.sensorkit.reader.allow ? | SensorKit Reader Access
SHALLOW_DEPTH_PRESSURE i
  com.apple.developer.submerged-shallow-depth-and-pressure | Shallow Depth and Pressure
SHARED_WITH_YOU imt com.apple.developer.shared-with-you
  @development,adHoc,appStore,macAppStore | Shared with You
SIDE_BUTTON_INVOCATION i com.apple.developer.side-button-access.allow | Side Button Access
SIRIKIT it com.apple.developer.siri | Siri
SIRIKIT_MEDIA_INTENTS_HOMEPOD i com.apple.developer.mediasetup ? | SiriKit Media Intents on HomePod
SK_EXT_PURCHASE_OR_OFFERS_REGIONS it
  com.apple.developer.storekit.custom-purchase-link.allowed-regions | StoreKit External Purchases or Offers
SPATIAL_AUDIO_PROFILE imt com.apple.developer.spatial-audio.profile-access | Spatial Audio Profile
STOREKIT_EXTERNAL_PURCHASE imt
  com.apple.developer.storekit.external-purchase
  @development,adHoc,appStore,macAppStore ? | StoreKit External Purchase
STOREKIT_EXTERNAL_PURCHASE_LINK imt
  com.apple.developer.storekit.external-purchase-link
  @development,adHoc,appStore,macAppStore ? | StoreKit External Purchase Link
SUBMERGED_DEPTH_PRESSURE i com.apple.developer.submerged-depth-and-pressure
  ? | Submerged Depth and Pressure
SUGGESTED_ACTIONS im com.apple.developer.suggested-actions | Suggested Actions
SUSTAINED_EXECUTION im com.apple.developer.sustained-execution | Sustained Execution
SYSTEM_EXTENSION_INSTALL im com.apple.developer.system-extension.install | System Extension
SYSTEM_EXTENSION_REDISTRIBUTABLE m
  com.apple.developer.system-extension.redistributable ? | System Extension Redistributable
TAP_TO_DISPLAY_ID i com.apple.developer.proximity-reader.identity.display | ID Verifier - Display Only
TAP_TO_READ_ID i com.apple.developer.proximity-reader.identity.read ? | ID Verifier - Data Transfer
TRUST_INSIGHTS_BASE i com.apple.developer.trustinsights.base | Trust Insights
UPI_DEVICE_VALIDATION i com.apple.developer.upi-device-validation ? | UPI Device Validation
USERNOTIFICATIONS_COMMUNICATION im
  com.apple.developer.usernotifications.communication | Communication Notifications
USERNOTIFICATIONS_TIMESENSITIVE im
  com.apple.developer.usernotifications.time-sensitive | Time Sensitive Notifications
USERNOTIFICATION_FILTERING im
  com.apple.developer.usernotifications.filtering ? | Notification (NSE) Filtering
USER_ASSIGNED_DEVICE_NAME it
  com.apple.developer.device-information.user-assigned-device-name ? | User Assigned Device Name
USER_MANAGEMENT t com.apple.developer.user-management | User Management
VEHICULAR_CRASH_EVENT i com.apple.developer.severe-vehicular-crash-event ? | Severe Vehicular Crash Event
VMNET m com.apple.developer.networking.vmnet | VMNet
WALLET i com.apple.developer.pass-type-identifiers | Wallet
WEATHERKIT imt com.apple.developer.weatherkit | WeatherKit
WEB_BROWSER_ENGINE_HOST i com.apple.developer.web-browser-engine.host ? | Web Browser Engine Host
WEB_BROWSER_ENGINE_NETWORKING i
  com.apple.developer.web-browser-engine.networking ? | Web Browser Engine Networking
WEB_BROWSER_ENGINE_RENDERING i
  com.apple.developer.web-browser-engine.rendering ? | Web Browser Engine Rendering
WEB_BROWSER_ENGINE_WEBCONTENT i
  com.apple.developer.web-browser-engine.webcontent ? | Web Browser Engine Web Content
WEB_BROWSER_PUBLIC_KEY_CREDENTIALS_REQUESTS m
  com.apple.developer.web-browser.public-key-credential ? | Web Browser Public Key Credential Requests
WIFI_AWARE i com.apple.developer.wifi-aware | Wi-Fi Aware
WIFI_NETWORK_SHARING i com.apple.developer.wifi-infrastructure | Wi-Fi Network Sharing
WINDOW_BODY_FOLLOW i com.apple.developer.window-body-follow ? | Window Body Follow
WIRELESS_ACCESSORY_CONFIGURATION i
  com.apple.external-accessory.wireless-configuration | Wireless Accessory Configuration
WIRELESS_INSIGHTS_SERVICE_PREDICTIONS i
  com.apple.developer.wireless-insights.service-predictions | Wireless Insights Service Predictions
`

/**
 * The capability types the App Store Connect API's `POST
 * /v1/bundleIdCapabilities` takes: its OpenAPI specification 4.5.1's
 * `CapabilityType` enum. Apple refuses any other with HTTP 409.
 */
export const publicCapabilityTypes: ReadonlySet<string> = new Set([
  'ICLOUD',
  'IN_APP_PURCHASE',
  'GAME_CENTER',
  'PUSH_NOTIFICATIONS',
  'WALLET',
  'INTER_APP_AUDIO',
  'MAPS',
  'ASSOCIATED_DOMAINS',
  'PERSONAL_VPN',
  'APP_GROUPS',
  'HEALTHKIT',
  'HOMEKIT',
  'WIRELESS_ACCESSORY_CONFIGURATION',
  'APPLE_PAY',
  'DATA_PROTECTION',
  'SIRIKIT',
  'NETWORK_EXTENSIONS',
  'MULTIPATH',
  'HOT_SPOT',
  'NFC_TAG_READING',
  'CLASSKIT',
  'AUTOFILL_CREDENTIAL_PROVIDER',
  'ACCESS_WIFI_INFORMATION',
  'NETWORK_CUSTOM_PROTOCOL',
  'COREMEDIA_HLS_LOW_LATENCY',
  'SYSTEM_EXTENSION_INSTALL',
  'USER_MANAGEMENT',
  'APPLE_ID_AUTH',
])

/** A line of the table. */
export interface Capability {
  type: string
  name: string
  platforms: ApplePlatform[]
  keys: string[]
  distributions?: Distribution[]
  /** By key, the values that choose this capability over others with the key. */
  values?: Record<string, string[]>
  requested: boolean
}

const platformLetters: Record<string, ApplePlatform> = {
  i: 'ios',
  m: 'macos',
  t: 'tvos',
}

function parse(text: string): Capability[] {
  const out: Capability[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const [words, name] = line.split(' | ')
    const tokens = words!.trim().split(/\s+/)
    if (!/^\s/.test(line)) {
      const [type, letters] = tokens.splice(0, 2) as [string, string]
      out.push({
        type,
        name: type,
        platforms: [...letters].map((letter) => platformLetters[letter]!),
        keys: [],
        requested: false,
      })
    }
    const entry = out.at(-1)!
    if (name != null) entry.name = name.trim()
    for (const token of tokens)
      if (token === '?') entry.requested = true
      else if (token.startsWith('@'))
        entry.distributions = token.slice(1).split(',') as Distribution[]
      else {
        const [key, values] = token.split('=') as [string, string | undefined]
        entry.keys.push(key)
        if (values != null)
          entry.values = { ...entry.values, [key]: values.split(',') }
      }
  }
  return out
}

export const capabilities: readonly Capability[] = parse(table)

const byKey = new Map<string, Capability[]>()
for (const entry of capabilities)
  for (const key of entry.keys)
    byKey.set(key, [...(byKey.get(key) ?? []), entry])

/**
 * Entitlements no capability grants: Xcode adds the first ones to every
 * signature, an App Clip's parent and child identifiers follow the bundle
 * IDs, and every `com.apple.security.` key not in the table — App Sandbox
 * and Hardened Runtime — is a promise the app makes, not a grant.
 */
const withoutCapability = new Set([
  'application-identifier',
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
  'get-task-allow',
  'keychain-access-groups',
  'beta-reports-active',
  'com.apple.developer.associated-appclip-app-identifiers',
  'com.apple.developer.parent-application-identifiers',
])
const needsNoCapability = (key: string): boolean =>
  withoutCapability.has(key) || key.startsWith('com.apple.security.')

/** An entitlement's value as the strings the table compares: `true`, a string, an array's strings. */
const valuesOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).map((item) => String(item))

/** A capability's setting, as App Store Connect's API takes it. */
export interface CapabilitySetting {
  key: string
  options: Array<{ key: string }>
}
/** A capability a bundle's entitlements need. */
export interface NeededCapability {
  type: string
  name: string
  /** The entitlement keys that need it. */
  keys: string[]
  settings?: CapabilitySetting[]
  /** Apple grants it only on request. */
  requested: boolean
}

const protectionLevels: Record<string, string> = {
  NSFileProtectionComplete: 'COMPLETE_PROTECTION',
  NSFileProtectionCompleteUnlessOpen: 'PROTECTED_UNLESS_OPEN',
  NSFileProtectionCompleteUntilFirstUserAuthentication:
    'PROTECTED_UNTIL_FIRST_USER_AUTH',
}

/**
 * The settings App Store Connect needs to enable a capability: iCloud with
 * CloudKit (Xcode 6 and later), the data protection level the entitlement
 * names, and Sign in with Apple as the primary App ID.
 */
export function settingsFor(
  type: string,
  entitlements: Record<string, unknown>,
): CapabilitySetting[] | undefined {
  const setting = (key: string, option: string): CapabilitySetting[] => [
    { key, options: [{ key: option }] },
  ]
  if (type === 'ICLOUD') return setting('ICLOUD_VERSION', 'XCODE_6')
  if (type === 'APPLE_ID_AUTH')
    return setting('APPLE_ID_AUTH_APP_CONSENT', 'PRIMARY_APP_CONSENT')
  if (type === 'DATA_PROTECTION') {
    const value = String(
      entitlements['com.apple.developer.default-data-protection'],
    )
    const level = protectionLevels[value]
    if (level == null)
      throw new Error(
        `com.apple.developer.default-data-protection is ${value}, not one of ${Object.keys(protectionLevels).join(', ')}`,
      )
    return setting('DATA_PROTECTION_PERMISSION_LEVEL', level)
  }
  return undefined
}

/**
 * The capabilities a bundle's entitlements need on its bundle ID for a
 * platform's profiles of a distribution. Where several capabilities share
 * a key, the one the key's value chooses wins, then a development-only one
 * for development, then one Apple grants without a request. A key whose
 * capabilities are for other platforms or distributions needs nothing
 * there. Keys Mason does not know are listed apart.
 */
export function capabilitiesFor(
  entitlements: Record<string, unknown>,
  platform: ApplePlatform,
  distribution: Distribution,
): { needed: NeededCapability[]; unknown: string[] } {
  const needed = new Map<string, NeededCapability>()
  const unknown: string[] = []
  for (const [key, value] of Object.entries(entitlements)) {
    // A key set to false asks for nothing.
    if (value === false) continue
    const candidates = byKey.get(key)
    if (candidates == null) {
      if (!needsNoCapability(key)) unknown.push(key)
      continue
    }
    const usable = candidates.filter(
      (entry) =>
        entry.platforms.includes(platform) &&
        (entry.distributions?.includes(distribution) ?? true),
    )
    const values = valuesOf(value)
    const chosen = usable.filter((entry) => {
      const allowed = entry.values?.[key]
      return allowed == null || values.every((item) => allowed.includes(item))
    })
    const rank = (entry: Capability): number =>
      (distribution === 'development' &&
      entry.distributions?.length === 1 &&
      entry.distributions[0] === 'development'
        ? 0
        : 2) + (entry.requested ? 1 : 0)
    const best = (chosen.length > 0 ? chosen : usable).sort(
      (a, b) => rank(a) - rank(b),
    )[0]
    if (best == null) continue
    const entry = needed.get(best.type) ?? {
      type: best.type,
      name: best.name,
      keys: [],
      requested: best.requested,
    }
    entry.keys.push(key)
    needed.set(best.type, entry)
  }
  return {
    needed: [...needed.values()]
      .map((entry) => {
        const settings = settingsFor(entry.type, entitlements)
        return settings == null ? entry : { ...entry, settings }
      })
      .sort((a, b) => a.type.localeCompare(b.type)),
    unknown: unknown.sort(),
  }
}

/** Why entitlement keys Mason does not know cannot be provisioned. */
export const unknownKeys = (keys: string[]): string =>
  `${keys.join(', ')} ${keys.length === 1 ? 'needs a capability' : 'need capabilities'} Mason cannot enable`
