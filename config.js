/* ==========================================
   APP CONFIGURATION & INITIALIZATION
   ========================================== */

const SUPABASE_URL = 'https://zwmlfmvpecvbbevlojum.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YokzYBoJz8w8tLXZ_CYs9g_TWPc-AXT';
const GOOGLE_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyKPdyAIbBCyIO6nH22MOt9NG6_U-P3ckYH4FIB-1TnxeBqqz0XafgB7SOWKkRxPLJr/exec";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const STORAGE_BUCKET = 'course-notes';

// Used by the viewer to read PDF chunks straight from Google Drive (fast route)
const GOOGLE_DRIVE_API_KEY = 'AIzaSyDgHjD0liJB2rzBMy2YXLPhTnU5x_x2q7Y';
