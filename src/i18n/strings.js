// UI strings table. English is the source language and the key: t("Complete sale") returns the
// Hindi / Marathi text when that language is selected, and the English text itself otherwise
// (or when a translation is missing — so an untranslated screen simply stays in English).
// {name} placeholders are filled by t(key, { name }).
//
// What is translated today: navigation, screen titles, the whole Billing screen and its
// messages, the printed receipt, sign-in, sync status, dialog buttons and the common empty
// states. Detailed labels inside the other screens are still English — add them here (key =
// the exact English text) and wrap the text in t() to translate more.
export const LANGS = [
  ["en", "English"],
  ["hi", "हिन्दी"],
  ["mr", "मराठी"],
];

// key → [Hindi, Marathi]
const T = {
  // ---- navigation
  Dashboard: ["डैशबोर्ड", "डॅशबोर्ड"],
  "Billing (POS)": ["बिलिंग", "बिलिंग"],
  Inventory: ["स्टॉक", "स्टॉक"],
  "Sales History": ["बिक्री इतिहास", "विक्री इतिहास"],
  Finance: ["वित्त", "वित्त"],
  Reports: ["रिपोर्ट", "अहवाल"],
  "Udhari (Credit)": ["उधारी", "उधारी"],
  "Add Expense": ["खर्च जोड़ें", "खर्च जोडा"],
  "Supplier Bills": ["सप्लायर बिल", "पुरवठादार बिले"],
  Other: ["अन्य", "इतर"],
  Alerts: ["अलर्ट", "सूचना"],
  "Vendor Bills": ["विक्रेता बिल", "विक्रेता बिले"],
  "Data Import": ["डेटा इम्पोर्ट", "डेटा इम्पोर्ट"],
  "Activity Log": ["गतिविधि लॉग", "कृती नोंद"],
  Settings: ["सेटिंग्स", "सेटिंग्ज"],
  Admin: ["एडमिन", "ॲडमिन"],
  Backup: ["बैकअप", "बॅकअप"],
  "Restore (JSON / XLSX)": ["रिस्टोर (JSON / XLSX)", "रिस्टोअर (JSON / XLSX)"],
  Reset: ["रीसेट", "रीसेट"],
  Logout: ["लॉगआउट", "लॉगआउट"],
  Language: ["भाषा", "भाषा"],
  "Signed in as {email}.": ["{email} से साइन इन हैं।", "{email} ने साइन इन केले आहे."],
  "Back up regularly.": ["नियमित बैकअप लें।", "नियमित बॅकअप घ्या."],

  // ---- screen titles
  Billing: ["बिलिंग", "बिलिंग"],
  "Udhari / Credit": ["उधारी", "उधारी"],
  "Shop details": ["दुकान की जानकारी", "दुकानाची माहिती"],
  "Tap a product, pick size & colour, add to the bill": [
    "प्रोडक्ट चुनें, साइज़ और रंग चुनें, बिल में जोड़ें",
    "वस्तू निवडा, साइज आणि रंग निवडा, बिलात जोडा",
  ],
  "Outstanding credit by customer, across all time.": [
    "ग्राहक के अनुसार बकाया उधारी, अब तक की।",
    "ग्राहकानुसार बाकी उधारी, आजपर्यंतची.",
  ],
  "Record shop expenses — rent, electricity, supplies, salaries…": [
    "दुकान के खर्च दर्ज करें — किराया, बिजली, सामान, वेतन…",
    "दुकानाचे खर्च नोंदवा — भाडे, वीज, साहित्य, पगार…",
  ],
  "Size/colour variants running low (lowest stock first)": [
    "कम स्टॉक वाले साइज़/रंग (सबसे कम पहले)",
    "कमी स्टॉक असलेले साइज/रंग (सर्वात कमी आधी)",
  ],
  "Shop identity — shown in the header, receipts, and reports": [
    "दुकान की पहचान — हेडर, रसीद और रिपोर्ट में दिखती है",
    "दुकानाची ओळख — हेडर, पावती आणि अहवालात दिसते",
  ],

  // ---- sign in
  "Sign in": ["साइन इन", "साइन इन"],
  Email: ["ईमेल", "ईमेल"],
  Password: ["पासवर्ड", "पासवर्ड"],
  "Signing in…": ["साइन इन हो रहा है…", "साइन इन होत आहे…"],
  "Forgot password? Email me a reset link": [
    "पासवर्ड भूल गए? रीसेट लिंक ईमेल करें",
    "पासवर्ड विसरलात? रीसेट लिंक ईमेल करा",
  ],
  "Sign in with your shop account. Your data syncs live across every device that signs in.": [
    "अपने दुकान के खाते से साइन इन करें। आपका डेटा हर साइन-इन डिवाइस पर लाइव सिंक होता है।",
    "तुमच्या दुकानाच्या खात्याने साइन इन करा. तुमचा डेटा प्रत्येक साइन-इन डिव्हाइसवर लाइव्ह सिंक होतो.",
  ],

  // ---- billing
  "Bill date": ["बिल की तारीख", "बिलाची तारीख"],
  "Search name / brand / code… (Enter opens top match)": [
    "नाम / ब्रांड / कोड खोजें… (Enter से पहला नतीजा खुलेगा)",
    "नाव / ब्रँड / कोड शोधा… (Enter ने पहिला निकाल उघडेल)",
  ],
  Misc: ["अन्य", "इतर"],
  "Name (optional)": ["नाम (वैकल्पिक)", "नाव (ऐच्छिक)"],
  buy: ["खरीद", "खरेदी"],
  sell: ["बिक्री", "विक्री"],
  "+ Add": ["+ जोड़ें", "+ जोडा"],
  "No products match.": ["कोई प्रोडक्ट नहीं मिला।", "एकही वस्तू सापडली नाही."],
  "No products yet — add some in Inventory.": [
    "अभी कोई प्रोडक्ट नहीं — स्टॉक में जोड़ें।",
    "अजून वस्तू नाहीत — स्टॉकमध्ये जोडा.",
  ],
  "Open Inventory": ["स्टॉक खोलें", "स्टॉक उघडा"],
  "Clear search": ["खोज साफ़ करें", "शोध पुसा"],
  "Out of stock": ["स्टॉक खत्म", "स्टॉक संपला"],
  "{n} in stock": ["{n} स्टॉक में", "{n} स्टॉकमध्ये"],
  "Current bill": ["चालू बिल", "चालू बिल"],
  "⏸ Hold": ["⏸ होल्ड", "⏸ होल्ड"],
  "Held bills ({n})": ["रुके हुए बिल ({n})", "थांबवलेली बिले ({n})"],
  "No items yet. Tap a product to begin.": [
    "अभी कोई आइटम नहीं। शुरू करने के लिए प्रोडक्ट चुनें।",
    "अजून वस्तू नाहीत. सुरू करण्यासाठी वस्तू निवडा.",
  ],
  Discount: ["छूट", "सूट"],
  Subtotal: ["उप-योग", "उपबेरीज"],
  Total: ["कुल", "एकूण"],
  UPI: ["UPI", "UPI"],
  Cash: ["नकद", "रोख"],
  Udhari: ["उधारी", "उधारी"],
  "Customer name (for the credit book)": [
    "ग्राहक का नाम (उधारी खाते के लिए)",
    "ग्राहकाचे नाव (उधारी वहीसाठी)",
  ],
  "Customer name (optional)": ["ग्राहक का नाम (वैकल्पिक)", "ग्राहकाचे नाव (ऐच्छिक)"],
  "Mobile (optional)": ["मोबाइल (वैकल्पिक)", "मोबाईल (ऐच्छिक)"],
  "Paid now (optional)": ["अभी दिया (वैकल्पिक)", "आता दिले (ऐच्छिक)"],
  "Complete sale · {amount}": ["बिक्री पूरी करें · {amount}", "विक्री पूर्ण करा · {amount}"],
  "🧾 Print last receipt": ["🧾 पिछली रसीद प्रिंट करें", "🧾 मागील पावती प्रिंट करा"],
  "{name} — pick size & colour": ["{name} — साइज़ और रंग चुनें", "{name} — साइज आणि रंग निवडा"],
  "{n} available": ["{n} उपलब्ध", "{n} उपलब्ध"],
  Done: ["हो गया", "झाले"],
  "{n} items": ["{n} आइटम", "{n} वस्तू"],
  "Out of stock: {name}": ["स्टॉक खत्म: {name}", "स्टॉक संपला: {name}"],
  "{name} — {variant} is out of stock": [
    "{name} — {variant} का स्टॉक खत्म है",
    "{name} — {variant} चा स्टॉक संपला आहे",
  ],
  "Only {n} of {name} ({variant}) in stock": [
    "{name} ({variant}) के सिर्फ़ {n} स्टॉक में हैं",
    "{name} ({variant}) चे फक्त {n} स्टॉकमध्ये आहेत",
  ],
  "Only {n} in stock": ["सिर्फ़ {n} स्टॉक में हैं", "फक्त {n} स्टॉकमध्ये आहेत"],
  "Enter a price for the misc item.": ["अन्य आइटम की कीमत डालें।", "इतर वस्तूची किंमत टाका."],
  "Enter a valid buy price (or leave it blank).": [
    "सही खरीद कीमत डालें (या खाली छोड़ें)।",
    "योग्य खरेदी किंमत टाका (किंवा रिकामे ठेवा).",
  ],
  "Added “{name}” · {amount}": ["“{name}” जोड़ा · {amount}", "“{name}” जोडले · {amount}"],
  "Misc item": ["अन्य आइटम", "इतर वस्तू"],
  "Bill held — tap it under “Held bills” to resume": [
    "बिल होल्ड पर है — दोबारा शुरू करने के लिए “रुके हुए बिल” में उसे दबाएँ",
    "बिल होल्डवर आहे — पुन्हा सुरू करण्यासाठी “थांबवलेली बिले” मध्ये त्यावर टॅप करा",
  ],
  "Resumed — the bill you were on is now held": [
    "दोबारा शुरू — जिस बिल पर आप थे वह अब होल्ड पर है",
    "पुन्हा सुरू — तुम्ही ज्या बिलावर होता ते आता होल्डवर आहे",
  ],
  "Bill resumed": ["बिल दोबारा शुरू", "बिल पुन्हा सुरू"],
  "Held bill discarded": ["होल्ड बिल हटाया गया", "होल्ड बिल काढले"],
  "Only {n} of {name} ({variant}) left — adjust the bill.": [
    "{name} ({variant}) के सिर्फ़ {n} बचे हैं — बिल ठीक करें।",
    "{name} ({variant}) चे फक्त {n} शिल्लक आहेत — बिल दुरुस्त करा.",
  ],
  "Bill saved ({pay}) — {amount}": [
    "बिल सेव हो गया ({pay}) — {amount}",
    "बिल सेव्ह झाले ({pay}) — {amount}",
  ],
  "Saved on this device ({pay}) — {amount} · will sync when online": [
    "इस डिवाइस पर सेव ({pay}) — {amount} · ऑनलाइन होने पर सिंक होगा",
    "या डिव्हाइसवर सेव्ह ({pay}) — {amount} · ऑनलाइन झाल्यावर सिंक होईल",
  ],

  // ---- sales history / shared actions
  "Bill deleted, stock restored": [
    "बिल हटाया गया, स्टॉक वापस जोड़ा गया",
    "बिल हटवले, स्टॉक परत जोडला",
  ],
  "Bill restored": ["बिल वापस आ गया", "बिल परत आले"],
  "No sales yet. Bills will appear here after you complete a sale.": [
    "अभी कोई बिक्री नहीं। बिक्री पूरी करने पर बिल यहाँ दिखेंगे।",
    "अजून विक्री नाही. विक्री पूर्ण केल्यावर बिले इथे दिसतील.",
  ],
  "Start billing": ["बिलिंग शुरू करें", "बिलिंग सुरू करा"],
  "New bill": ["नया बिल", "नवीन बिल"],
  "No outstanding credit — all udhari settled. 🎉": [
    "कोई उधारी बाकी नहीं — सब चुकता। 🎉",
    "उधारी बाकी नाही — सर्व चुकते. 🎉",
  ],
  "All products are well stocked.": [
    "सभी प्रोडक्ट का स्टॉक ठीक है।",
    "सर्व वस्तूंचा स्टॉक पुरेसा आहे.",
  ],
  "No bills yet today.": ["आज अभी कोई बिल नहीं।", "आज अजून बिल नाही."],
  "No products yet.": ["अभी कोई प्रोडक्ट नहीं।", "अजून वस्तू नाहीत."],
  "+ Add product": ["+ प्रोडक्ट जोड़ें", "+ वस्तू जोडा"],
  "+ Add your first product": ["+ पहला प्रोडक्ट जोड़ें", "+ पहिली वस्तू जोडा"],
  Undo: ["वापस लें", "पूर्ववत करा"],
  Cancel: ["रद्द करें", "रद्द करा"],
  Delete: ["हटाएँ", "हटवा"],
  OK: ["ठीक है", "ठीक आहे"],
  "Dismiss message": ["संदेश हटाएँ", "संदेश काढा"],
  "Loading…": ["लोड हो रहा है…", "लोड होत आहे…"],
  "Loading store data…": ["दुकान का डेटा लोड हो रहा है…", "दुकानाचा डेटा लोड होत आहे…"],

  // ---- sync status
  "Online · syncing live": ["ऑनलाइन · लाइव सिंक", "ऑनलाइन · लाइव्ह सिंक"],
  Online: ["ऑनलाइन", "ऑनलाइन"],
  "Offline · saved on this device": ["ऑफ़लाइन · इस डिवाइस पर सेव", "ऑफलाइन · या डिव्हाइसवर सेव्ह"],
  "Offline · {what} waiting to sync": [
    "ऑफ़लाइन · {what} सिंक होना बाकी",
    "ऑफलाइन · {what} सिंक व्हायचे बाकी",
  ],
  "Online · syncing {what}…": ["ऑनलाइन · {what} सिंक हो रहा है…", "ऑनलाइन · {what} सिंक होत आहे…"],
  "{what} not synced — tap to retry": [
    "{what} सिंक नहीं हुआ — दोबारा कोशिश के लिए दबाएँ",
    "{what} सिंक झाले नाही — पुन्हा प्रयत्नासाठी टॅप करा",
  ],
  "{n} bill": ["{n} बिल", "{n} बिल"],
  "{n} bills": ["{n} बिल", "{n} बिले"],
  "{n} change": ["{n} बदलाव", "{n} बदल"],
  "{n} changes": ["{n} बदलाव", "{n} बदल"],
  "{n} other change": ["{n} अन्य बदलाव", "{n} इतर बदल"],
  "{n} other changes": ["{n} अन्य बदलाव", "{n} इतर बदल"],
  "{a} + {b}": ["{a} + {b}", "{a} + {b}"],

  // ---- receipt
  TOTAL: ["कुल", "एकूण"],
  "Size {size}": ["साइज़ {size}", "साइज {size}"],
  "Paid via {mode}": ["भुगतान: {mode}", "पेमेंट: {mode}"],
  "Customer: {name}": ["ग्राहक: {name}", "ग्राहक: {name}"],
  "Paid now: {amount}": ["अभी दिया: {amount}", "आता दिले: {amount}"],
  "Balance due: {amount}": ["बाकी: {amount}", "बाकी: {amount}"],
  "Scan to Pay · UPI": ["स्कैन करके भुगतान करें · UPI", "स्कॅन करून पैसे द्या · UPI"],
  Receipt: ["रसीद", "पावती"],
  "Bill no: {no}": ["बिल नं: {no}", "बिल क्र: {no}"],
  Taxable: ["करयोग्य", "करपात्र"],
  "Exchange credit": ["एक्सचेंज क्रेडिट", "एक्सचेंज क्रेडिट"],
  "To pay": ["देय राशि", "देय रक्कम"],
  RETURN: ["वापसी", "परत"],
  "Prices include GST": ["कीमतों में GST शामिल है", "किमतींमध्ये GST समाविष्ट आहे"],
  "TAX INVOICE": ["टैक्स इनवॉइस", "टॅक्स इन्व्हॉइस"],
  "Send on WhatsApp": ["WhatsApp पर भेजें", "WhatsApp वर पाठवा"],
};

export const STRINGS = {
  en: Object.fromEntries(Object.keys(T).map((k) => [k, k])),
  hi: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v[0]])),
  mr: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v[1]])),
};
