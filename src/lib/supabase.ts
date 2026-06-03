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
  happy_hour_price: number | null;
  /** Human-readable HH window e.g. "17h–20h". null = unknown */
  happy_hour_times?: string | null;
  price_source: string | null;
  submitted_by: string | null;
  last_updated: string;
  serves_beer: boolean | null;
  amenity_type: string | null;
  has_terrace: boolean | null;
  terrace_grande: boolean | null;
  /** Google regularOpeningHours.periods — null = not yet fetched */
  opening_hours: HoursPeriod[] | null;
  /** Happy hour periods, same shape as opening_hours. null = unknown/not migrated yet */
  happy_hour_periods?: HoursPeriod[] | null;
  happy_hour_source?: string | null;
  happy_hour_updated_at?: string | null;
  /** Max closing hour in 24+ notation (26 = 2 am, 29 = 5 am). null = unknown */
  close_hour: number | null;
};
