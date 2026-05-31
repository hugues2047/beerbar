// This file creates the connection to our Supabase database.
// We import it wherever we need to read or write data.
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// This is the shape of a bar record in our database
export type HoursPeriod = {
  open:  { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
};

export type Bar = {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  beer_price: number;
  price_source: string | null;
  phone: string | null;
  submitted_by: string | null;
  last_updated: string;
  serves_beer: boolean | null;
  amenity_type: string | null;
  has_terrace: boolean | null;
  terrace_grande: boolean | null;
  /** Google regularOpeningHours.periods — null = not yet fetched */
  opening_hours: HoursPeriod[] | null;
  /** Max closing hour in 24+ notation (26 = 2 am, 29 = 5 am). null = unknown */
  close_hour: number | null;
};
