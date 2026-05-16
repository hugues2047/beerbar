// This file creates the connection to our Supabase database.
// We import it wherever we need to read or write data.
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// This is the shape of a bar record in our database
export type Bar = {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  beer_price: number;
  phone: string | null;
  submitted_by: string | null;
  last_updated: string;
};
