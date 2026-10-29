"use client";

/**
 * Passengers manager — list + create / edit / delete saved passengers.
 * Passengers are reused across bookings.
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, Trash2, Pencil, X } from "lucide-react";
import * as api from "@/lib/dashboard/api";
import { BERTH_PREFERENCES, FOOD_PREFERENCES, type PassengerDTO } from "@/lib/agent/types";

interface Props {
  passengers: PassengerDTO[];
  onChange: () => void;
}

interface FormState {
  id?: string;
  name: string;
  age: string;
  gender: "M" | "F" | "T";
  berthPref: string;
  foodPref: string;
  nationality: string;
  isPrimary: boolean;
  aadhaarLast4: string;
}

const EMPTY: FormState = {
  name: "", age: "", gender: "M", berthPref: "NC", foodPref: "D", nationality: "India", isPrimary: false, aadhaarLast4: "",
};

export function PassengersManager({ passengers, onChange }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [showForm, setShowForm] = useState(false);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((c) => ({ ...c, [k]: v }));

  const submit = async () => {
    if (!form.name || !form.age) {
      toast({ title: "Missing fields", description: "Name and age are required.", variant: "destructive" });
      return;
    }
    try {
      const payload = {
        name: form.name,
        age: Number(form.age),
        gender: form.gender,
        berthPref: form.berthPref,
        foodPref: form.foodPref,
        nationality: form.nationality,
        isPrimary: form.isPrimary,
        aadhaarLast4: form.aadhaarLast4 || null,
      };
      if (form.id) {
        await api.updatePassenger(form.id, payload);
        toast({ title: "Passenger updated" });
      } else {
        await api.createPassenger(payload);
        toast({ title: "Passenger added" });
      }
      setForm(EMPTY);
      setShowForm(false);
      onChange();
    } catch (err) {
      toast({ title: "Failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const edit = (p: PassengerDTO) => {
    setForm({
      id: p.id,
      name: p.name,
      age: String(p.age),
      gender: p.gender,
      berthPref: p.berthPref,
      foodPref: p.foodPref,
      nationality: p.nationality,
      isPrimary: p.isPrimary,
      aadhaarLast4: p.aadhaarLast4 ?? "",
    });
    setShowForm(true);
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this passenger?")) return;
    await api.deletePassenger(id);
    onChange();
    toast({ title: "Deleted" });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Saved passengers ({passengers.length})</CardTitle>
              <CardDescription>These will be auto-filled on the IRCTC passenger details page.</CardDescription>
            </div>
            {!showForm && (
              <Button onClick={() => { setForm(EMPTY); setShowForm(true); }} className="gap-2 bg-amber-600 hover:bg-amber-700 text-white">
                <UserPlus className="h-4 w-4" /> Add passenger
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {passengers.length === 0 && !showForm && (
            <div className="text-sm text-muted-foreground">No passengers yet. Click &quot;Add passenger&quot; to create one.</div>
          )}
          {passengers.map((p) => (
            <div key={p.id} className="rounded-md border p-3 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium flex items-center gap-2">
                  {p.name}
                  {p.isPrimary && <Badge variant="secondary" className="text-xs">primary</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {p.age} yrs · {p.gender === "M" ? "Male" : p.gender === "F" ? "Female" : "Transgender"} · Berth: {p.berthPref} · Food: {p.foodPref}
                  {p.aadhaarLast4 && ` · Aadhaar: ****${p.aadhaarLast4}`}
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => edit(p)} className="gap-2">
                  <Pencil className="h-3 w-3" /> Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(p.id)} className="gap-2 text-red-600 hover:text-red-700">
                  <Trash2 className="h-3 w-3" /> Delete
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {showForm && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{form.id ? "Edit passenger" : "Add passenger"}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setShowForm(false)} className="gap-2">
                <X className="h-4 w-4" /> Close
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Full name (as on IRCTC)</Label>
                <Input id="name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. RAHUL SHARMA" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="age">Age</Label>
                <Input id="age" type="number" min={1} max={120} value={form.age} onChange={(e) => set("age", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Gender</Label>
                <Select value={form.gender} onValueChange={(v) => set("gender", v as "M" | "F" | "T")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">Male</SelectItem>
                    <SelectItem value="F">Female</SelectItem>
                    <SelectItem value="T">Transgender</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Berth preference</Label>
                <Select value={form.berthPref} onValueChange={(v) => set("berthPref", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BERTH_PREFERENCES.map((b) => <SelectItem key={b.code} value={b.code}>{b.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Food preference</Label>
                <Select value={form.foodPref} onValueChange={(v) => set("foodPref", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FOOD_PREFERENCES.map((f) => <SelectItem key={f.code} value={f.code}>{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="aadhaar">Aadhaar last 4 (optional)</Label>
                <Input id="aadhaar" maxLength={4} value={form.aadhaarLast4} onChange={(e) => set("aadhaarLast4", e.target.value)} placeholder="1234" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.isPrimary} onCheckedChange={(v) => set("isPrimary", v === true)} />
              Mark as primary passenger (used as default contact)
            </label>
            <Button onClick={submit} className="bg-amber-600 hover:bg-amber-700 text-white">
              {form.id ? "Update passenger" : "Add passenger"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
