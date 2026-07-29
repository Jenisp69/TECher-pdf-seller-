const SUPABASE_URL = 'https://zwmlfmvpecvbbevlojum.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_YokzYBoJz8w8tLXZ_CYs9g_TWPc-AXT';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const STORAGE_BUCKET = 'course-notes';